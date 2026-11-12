import { logicalSubset } from './semantic-logic.mjs';
import {
  patternSubset,
  patternWitness,
  patternIntersectionSubset,
  patternProofProfile,
} from './pattern-proof.mjs';
import { referenceEquivalent } from './reference-proof.mjs';
import { legacySchemaDialect } from '../../core/src/schema-dialects.mjs';
import { isExactMultipleOf, exactCommonMultiple } from '../../core/src/number-validation.mjs';
import { createSchemaEngine, schemaFormatAssertions } from './schema-engine.mjs';
import { resourceDispatchRequired, schemaResourceGraph } from './schema-resource-graph.mjs';
import { compoundCompiler, resourceSchemaShape } from './compound-schema.mjs';
import { expandCompoundProof, compoundReferenceEquivalent } from './compound-proof.mjs';
import { recursiveContainment } from './recursive-containment.mjs';
import { conjunctiveContainment } from './conjunctive-containment.mjs';
import { compoundWitnessCandidates } from './compound-witnesses.mjs';
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const annotations = new Set([
  'title',
  'description',
  'default',
  'examples',
  'example',
  'deprecated',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  'x-paritydiff-vocabulary-profiles',
]);
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
]);
const literals = new Set(['const', 'enum', 'default', 'examples', 'example']);
function canonical(value, role = 'schema') {
  if (Array.isArray(value)) return value.map((item) => canonical(item, role));
  if (!value || typeof value !== 'object') return value;
  const output = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => role !== 'schema' || !annotations.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [
        key,
        canonical(
          item,
          role === 'literal'
            ? 'literal'
            : role === 'map'
              ? 'schema'
              : literals.has(key)
                ? 'literal'
                : maps.has(key)
                  ? 'map'
                  : 'schema',
        ),
      ]),
  );
  if (role === 'schema')
    for (const key of ['allOf', 'anyOf', 'oneOf', 'required', 'enum', 'type'])
      if (Array.isArray(output[key]))
        output[key].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (role === 'schema' && !Object.keys(output).length) return true;
  return output;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function finite(schema, limit = 256, depth = 0) {
  if (depth > 24) return undefined;
  if (schema === false) return [];
  const node = object(schema);
  if (Object.hasOwn(node, 'const')) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.length <= limit ? node.enum : undefined;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.every((type) => ['null', 'boolean'].includes(type)))
    return types.flatMap((type) => (type === 'null' ? [null] : [false, true]));
  for (const key of ['anyOf', 'oneOf'])
    if (Array.isArray(node[key])) {
      const children = node[key].map((child) => finite(child, limit, depth + 1));
      if (children.every((child) => child !== undefined) && children.flat().length <= limit)
        return children.flat();
    }
  if (Array.isArray(node.allOf)) {
    const bounded = node.allOf
      .map((child) => finite(child, limit, depth + 1))
      .find((child) => child !== undefined);
    if (bounded) return bounded;
  }
  if (
    node.type === 'integer' &&
    Number.isSafeInteger(node.minimum) &&
    Number.isSafeInteger(node.maximum) &&
    node.maximum - node.minimum < limit
  )
    return Array.from(
      { length: Math.max(0, node.maximum - node.minimum + 1) },
      (_, i) => node.minimum + i,
    );
  if (
    node.type === 'object' &&
    node.additionalProperties === false &&
    !Object.keys(object(node.patternProperties)).length
  ) {
    let values = [{}];
    const required = node.required ?? [];
    for (const [key, child] of Object.entries(object(node.properties))) {
      const domain = finite(child, limit, depth + 1);
      if (!domain) return undefined;
      const next = [];
      for (const value of values) {
        if (!required.includes(key)) next.push(value);
        for (const member of domain)
          next.push(Object.fromEntries([...Object.entries(value), [key, member]]));
      }
      if (next.length > limit) return undefined;
      values = next;
    }
    return values;
  }
  const maximum =
    node.maxItems ?? (node.items === false ? (node.prefixItems?.length ?? 0) : undefined);
  if (node.type === 'array' && Number.isInteger(maximum) && maximum >= 0 && maximum <= 8) {
    const values = [[]];
    let current = [[]];
    for (let length = 1; length <= maximum; length++) {
      const members = finite(
        node.prefixItems?.[length - 1] ?? node.items ?? true,
        limit,
        depth + 1,
      );
      if (!members) return undefined;
      current = current.flatMap((row) => members.map((member) => [...row, member]));
      if (values.length + current.length > limit) return undefined;
      values.push(...current);
    }
    return values;
  }
  return undefined;
}
const numberKeys = new Set([
  'type',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);
const stringKeys = new Set(['type', 'minLength', 'maxLength', 'pattern', 'format']);
const minimal = (schema, keys) => Object.keys(canonical(schema)).every((key) => keys.has(key));
function interval(schema, kind) {
  const node = object(schema);
  if (kind === 'string')
    return {
      low: node.minLength ?? 0,
      high: node.maxLength ?? Infinity,
      loOpen: false,
      hiOpen: false,
    };
  const low = Math.max(node.minimum ?? -Infinity, node.exclusiveMinimum ?? -Infinity),
    high = Math.min(node.maximum ?? Infinity, node.exclusiveMaximum ?? Infinity);
  const loOpen = node.exclusiveMinimum !== undefined && node.exclusiveMinimum === low,
    hiOpen = node.exclusiveMaximum !== undefined && node.exclusiveMaximum === high;
  return node.type === 'integer'
    ? {
        low: Math.ceil(low) + (loOpen && Number.isInteger(low) ? 1 : 0),
        high: Math.floor(high) - (hiOpen && Number.isInteger(high) ? 1 : 0),
        loOpen: false,
        hiOpen: false,
      }
    : { low, high, loOpen, hiOpen };
}
function subsetInterval(a, b) {
  return (
    (a.low > b.low || (a.low === b.low && (!b.loOpen || a.loOpen))) &&
    (a.high < b.high || (a.high === b.high && (!b.hiOpen || a.hiOpen)))
  );
}
function integerStep(multiple) {
  if (multiple === undefined) return 1n;
  if (!Number.isFinite(multiple) || multiple <= 0) return undefined;
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/.exec(String(multiple));
  if (!match) return undefined;
  const digits = match[1] + (match[2] ?? ''),
    exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(exponent) > 324) return undefined;
  let numerator = BigInt(digits),
    denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  const gcd = (a, b) => {
    while (b) [a, b] = [b, a % b];
    return a;
  };
  return numerator / gcd(numerator, denominator);
}
function integerModel(schema) {
  const bounds = interval(schema, 'integer'),
    step = integerStep(schema.multipleOf);
  if (
    !step ||
    step > BigInt(Number.MAX_SAFE_INTEGER) ||
    [bounds.low, bounds.high].some(
      (value) => Number.isFinite(value) && !Number.isSafeInteger(value),
    )
  )
    return undefined;
  const floor = (value) => (value >= 0n ? value / step : (value - step + 1n) / step);
  if (Number.isFinite(bounds.low)) bounds.low = Number(-floor(-BigInt(bounds.low)) * step);
  if (Number.isFinite(bounds.high)) bounds.high = Number(floor(BigInt(bounds.high)) * step);
  if (
    [bounds.low, bounds.high].some(
      (value) => Number.isFinite(value) && !Number.isSafeInteger(value),
    )
  )
    return undefined;
  return { ...bounds, step };
}
function numericSubset(source, target) {
  if (source.type === 'integer') {
    const model = integerModel(source);
    if (!model) return false;
    if (model.low > model.high) return true;
    const targetStep = integerStep(target.multipleOf);
    if (!targetStep || model.step % targetStep !== 0n) return false;
    const bounds = target.type === 'integer' ? integerModel(target) : interval(target, 'number');
    return Boolean(bounds && subsetInterval(model, bounds));
  }
  if (
    target.multipleOf !== undefined &&
    (source.multipleOf === undefined || !isExactMultipleOf(source.multipleOf, target.multipleOf))
  )
    return false;
  return subsetInterval(interval(source, 'number'), interval(target, 'number'));
}
function jointAssertions(parts) {
  const lower = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']);
  const upper = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']);
  const supported = new Set([
    ...lower,
    ...upper,
    'type',
    'multipleOf',
    'required',
    'dependentRequired',
    'uniqueItems',
    'pattern',
    'format',
    'const',
    'enum',
  ]);
  if (
    !parts.every(
      (part) =>
        part && typeof part === 'object' && Object.keys(part).every((key) => supported.has(key)),
    )
  )
    return undefined;
  const result = {};
  let types;
  const universe = ['null', 'boolean', 'object', 'array', 'string', 'number', 'integer'];
  for (const part of parts) {
    if (part.type !== undefined) {
      const declared = Array.isArray(part.type) ? part.type : [part.type];
      const domain = universe.filter(
        (type) => declared.includes(type) || (type === 'integer' && declared.includes('number')),
      );
      types = types ? types.filter((type) => domain.includes(type)) : domain;
    }
    for (const [key, value] of Object.entries(part)) {
      if (key === 'type' || key === 'multipleOf') continue;
      if (lower.has(key)) result[key] = Math.max(result[key] ?? -Infinity, value);
      else if (upper.has(key)) result[key] = Math.min(result[key] ?? Infinity, value);
      else if (key === 'required')
        result.required = [...new Set([...(result.required ?? []), ...value])];
      else if (key === 'dependentRequired') {
        result.dependentRequired = Object.fromEntries(
          [...new Set([...Object.keys(result.dependentRequired ?? {}), ...Object.keys(value)])].map(
            (name) => [
              name,
              [...new Set([...(result.dependentRequired?.[name] ?? []), ...(value[name] ?? [])])],
            ],
          ),
        );
      } else if (key === 'uniqueItems') result.uniqueItems = Boolean(result.uniqueItems || value);
      else if (key === 'enum')
        result.enum = result.enum
          ? result.enum.filter((member) =>
              value.some(
                (candidate) =>
                  JSON.stringify(canonical(member, 'literal')) ===
                  JSON.stringify(canonical(candidate, 'literal')),
              ),
            )
          : value;
      else if (
        Object.hasOwn(result, key) &&
        JSON.stringify(canonical(result[key], 'literal')) !==
          JSON.stringify(canonical(value, 'literal'))
      ) {
        if (key === 'const') return false;
        return undefined;
      } else result[key] = value;
    }
  }
  if (types) {
    if (!types.length) return false;
    if (types.includes('number')) types = types.filter((type) => type !== 'integer');
    result.type = types.length === 1 ? types[0] : types;
  }
  const multiples = parts.map((part) => part.multipleOf).filter((value) => value !== undefined);
  if (multiples.length) {
    const multiple = exactCommonMultiple(multiples);
    if (multiple === undefined) return undefined;
    result.multipleOf = multiple;
  }
  if (result.enum && !result.enum.length) return false;
  if (
    Object.hasOwn(result, 'const') &&
    result.enum &&
    !result.enum.some(
      (value) =>
        JSON.stringify(canonical(value, 'literal')) ===
        JSON.stringify(canonical(result.const, 'literal')),
    )
  )
    return false;
  if (typeof result.type === 'string') {
    const domains = [
      [
        ['number', 'integer'],
        ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
      ],
      [['string'], ['minLength', 'maxLength', 'pattern']],
      [['object'], ['required', 'dependentRequired', 'minProperties', 'maxProperties']],
      [['array'], ['minItems', 'maxItems', 'uniqueItems']],
    ];
    for (const [types, keywords] of domains)
      if (!types.includes(result.type)) for (const keyword of keywords) delete result[keyword];
  }
  return result;
}
function primitiveConjunction(schema, depth = 0, role = 'schema') {
  if (!schema || typeof schema !== 'object' || role === 'literal' || depth > 24) return schema;
  if (Array.isArray(schema))
    return schema.map((child) => primitiveConjunction(child, depth + 1, role));
  const node = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      primitiveConjunction(
        value,
        depth + 1,
        role === 'map'
          ? 'schema'
          : literals.has(key)
            ? 'literal'
            : maps.has(key)
              ? 'map'
              : 'schema',
      ),
    ]),
  );
  if (role !== 'schema' || !Array.isArray(node.allOf)) return node;
  const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'allOf'));
  const flatten = (part, level = 0) => {
    if (level > 24 || !part || typeof part !== 'object' || !Array.isArray(part.allOf))
      return [part];
    return [
      Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'allOf')),
      ...part.allOf.flatMap((child) => flatten(child, level + 1)),
    ];
  };
  const parts = [siblings, ...node.allOf.flatMap((part) => flatten(part))].filter(
    (part) => part !== true,
  );
  if (parts.includes(false)) return false;
  const joint = jointAssertions(parts);
  if (joint !== undefined) return joint;
  const kinds = new Set(parts.map((part) => part.type).filter((type) => type !== undefined));
  if (!kinds.size || [...kinds].some((type) => !['number', 'integer', 'string'].includes(type)))
    return node;
  if (kinds.has('string') && kinds.size > 1) return false;
  const type = kinds.has('string') ? 'string' : kinds.has('integer') ? 'integer' : 'number';
  if (!parts.every((part) => minimal(part, type === 'string' ? stringKeys : numberKeys)))
    return node;
  const result = { type };
  for (const key of type === 'string'
    ? ['minLength', 'maxLength']
    : ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    const values = parts.filter((part) => part[key] !== undefined).map((part) => part[key]);
    if (values.length)
      result[key] = ['maximum', 'exclusiveMaximum', 'maxLength'].includes(key)
        ? Math.min(...values)
        : Math.max(...values);
  }
  if (type === 'string') {
    for (const key of ['pattern', 'format']) {
      const values = [
        ...new Set(parts.map((part) => part[key]).filter((value) => value !== undefined)),
      ];
      if (values.length > 1) return node;
      if (values.length) result[key] = values[0];
    }
  } else {
    const multiples = parts.map((part) => part.multipleOf).filter((value) => value !== undefined);
    if (multiples.length && type === 'integer') {
      const gcd = (a, b) => {
        while (b) [a, b] = [b, a % b];
        return a;
      };
      let multiple = 1n;
      for (const value of multiples) {
        const step = integerStep(value);
        if (!step) return node;
        multiple = (multiple / gcd(multiple, step)) * step;
        if (multiple > BigInt(Number.MAX_SAFE_INTEGER)) return node;
      }
      result.multipleOf = Number(multiple);
    } else if (multiples.length) {
      const multiple = exactCommonMultiple(multiples);
      if (multiple === undefined) return node;
      result.multipleOf = multiple;
    }
  }
  return result;
}
const objectKeys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'dependentRequired',
]);
const property = (properties, key, fallback) =>
  Object.hasOwn(properties, key) ? properties[key] : fallback;
const arrayKeys = new Set([
  'type',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
]);
function arrayModel(schema, depth = 0) {
  const prefix = schema.prefixItems ?? [];
  const forbidden = prefix.indexOf(false);
  const model = {
    low: schema.minItems ?? 0,
    high: Math.min(
      schema.maxItems ?? Infinity,
      schema.items === false ? prefix.length : Infinity,
      forbidden < 0 ? Infinity : forbidden,
    ),
    prefix,
    rest: schema.items ?? true,
  };
  if (schema.contains !== undefined) {
    const minimum = schema.minContains ?? 1,
      maximum = schema.maxContains ?? Infinity;
    if (minimum > maximum || (schema.contains === false && minimum > 0)) model.high = -1;
    else if (
      model.prefix.slice(0, model.high).every((item) => subset(item, schema.contains, depth + 1)) &&
      (model.high <= model.prefix.length || subset(model.rest, schema.contains, depth + 1))
    ) {
      model.low = Math.max(model.low, minimum);
      model.high = Math.min(model.high, maximum);
    }
  }
  return model;
}
function matchingBounds(model, predicate, depth) {
  if (predicate === false) return { low: 0, high: 0 };
  let low = model.prefix
    .slice(0, model.low)
    .filter((item) => subset(item, predicate, depth + 1)).length;
  if (model.low > model.prefix.length && subset(model.rest, predicate, depth + 1))
    low += model.low - model.prefix.length;
  return { low, high: model.high };
}
function objectModel(schema, present = []) {
  const properties = object(schema.properties),
    additional = schema.additionalProperties ?? true,
    required = new Set([...(schema.required ?? []), ...present]),
    dependencies = object(schema.dependentRequired);
  for (const key of required)
    for (const dependent of property(dependencies, key, [])) required.add(dependent);
  const high = Math.min(
    schema.maxProperties ?? Infinity,
    additional === false
      ? Object.values(properties).filter((child) => child !== false).length
      : Infinity,
  );
  const low = Math.max(schema.minProperties ?? 0, required.size);
  return {
    properties,
    additional,
    required,
    low,
    high,
    empty:
      low > high || [...required].some((key) => property(properties, key, additional) === false),
  };
}
function subset(a, b, depth = 0, opaque = false) {
  if (depth > 24) return false;
  if (a === false || b === true || equal(a, b)) return true;
  if (a === true)
    return (
      !opaque &&
      logicalSubset(a, b, (left, right) => subset(left, right, depth + 1, true), canonical)
    );
  const x = object(a),
    y = object(b);
  if (
    typeof x.type === 'string' &&
    b &&
    typeof b === 'object' &&
    !Array.isArray(b) &&
    y.type === undefined &&
    Object.keys(y).length
  )
    return subset(a, { ...b, type: x.type }, depth + 1, opaque);
  if (Array.isArray(x.allOf) || Array.isArray(y.allOf)) {
    const stringModel = (schema, nesting = 0) => {
      if (nesting > 24 || schema === false || !schema || typeof schema !== 'object')
        return undefined;
      const local = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'allOf'));
      if (!minimal(local, stringKeys)) return undefined;
      const children = (schema.allOf ?? []).map((child) =>
        child === true ? { parts: [], patterns: [] } : stringModel(child, nesting + 1),
      );
      if (children.some((child) => !child)) return undefined;
      const { pattern, ...rest } = local;
      return {
        parts: [rest, ...children.flatMap((child) => child.parts)],
        patterns: [
          ...(pattern === undefined ? [] : [pattern]),
          ...children.flatMap((child) => child.patterns),
        ],
      };
    };
    const source = stringModel(a),
      target = stringModel(b);
    if (source && target) {
      const p = jointAssertions(source.parts),
        q = jointAssertions(target.parts);
      if (p === false) return true;
      if (
        p?.type === 'string' &&
        q &&
        (q.type === undefined || q.type === 'string') &&
        subset(p, { ...q, type: 'string' }, depth + 1, true) &&
        patternIntersectionSubset(
          source.patterns,
          target.patterns,
          p.minLength ?? 0,
          p.maxLength ?? Infinity,
        )
      )
        return true;
    }
  }
  if (x.type === 'array' && minimal(x, arrayKeys)) {
    const model = arrayModel(x, depth);
    if (model.low > model.high) return true;
  }
  if (x.type === 'object' && minimal(x, objectKeys) && objectModel(x).empty) return true;
  if (x.type === 'integer' && minimal(x, numberKeys)) {
    const model = integerModel(x);
    if (model && model.low > model.high) return true;
  }
  if (
    ['number', 'string'].includes(x.type) &&
    minimal(x, x.type === 'string' ? stringKeys : numberKeys)
  ) {
    const bounds = interval(x, x.type);
    if (
      bounds.low > bounds.high ||
      (bounds.low === bounds.high && (bounds.loOpen || bounds.hiOpen))
    )
      return true;
  }
  if (b === false)
    return (
      !opaque &&
      logicalSubset(a, b, (left, right) => subset(left, right, depth + 1, true), canonical)
    );
  if (Array.isArray(x.anyOf)) return x.anyOf.every((child) => subset(child, b, depth + 1));
  if (Array.isArray(y.allOf) && Object.keys(canonical(y)).every((key) => key === 'allOf'))
    return y.allOf.every((child) => subset(a, child, depth + 1));
  if (Array.isArray(x.allOf) && x.allOf.some((child) => subset(child, b, depth + 1))) return true;
  if (
    Array.isArray(y.anyOf) &&
    Object.keys(canonical(y)).every((key) => key === 'anyOf') &&
    y.anyOf.some((child) => subset(a, child, depth + 1))
  )
    return true;
  if (
    x.type === y.type &&
    minimal(x, x.type === 'string' ? stringKeys : numberKeys) &&
    minimal(y, y.type === 'string' ? stringKeys : numberKeys) &&
    ['integer', 'number', 'string'].includes(x.type)
  )
    return x.type === 'string'
      ? patternSubset(x.pattern, y.pattern) &&
          (y.format === undefined || x.format === y.format) &&
          subsetInterval(interval(x, 'string'), interval(y, 'string'))
      : numericSubset(x, y);
  if (
    x.type === 'integer' &&
    y.type === 'number' &&
    minimal(x, numberKeys) &&
    minimal(y, numberKeys)
  )
    return numericSubset(x, y);
  if (x.type === 'array' && y.type === 'array' && minimal(x, arrayKeys) && minimal(y, arrayKeys)) {
    const source = arrayModel(x, depth),
      target = arrayModel(y, depth);
    if (source.low > source.high) return true;
    if (source.low < target.low || source.high > target.high) return false;
    if (source.high === 0) return true;
    if (y.uniqueItems && !x.uniqueItems && source.high > 1) return false;
    if (y.contains !== undefined) {
      const matches = matchingBounds(source, y.contains, depth);
      if (x.contains !== undefined) {
        if (subset(x.contains, y.contains, depth + 1))
          matches.low = Math.max(matches.low, x.minContains ?? 1);
        if (subset(y.contains, x.contains, depth + 1))
          matches.high = Math.min(matches.high, x.maxContains ?? Infinity);
      }
      if (matches.low < (y.minContains ?? 1) || matches.high > (y.maxContains ?? Infinity))
        return false;
    }
    const length = Math.max(source.prefix.length, target.prefix.length);
    for (let index = 0; index < Math.min(source.high, length); index++)
      if (
        !subset(source.prefix[index] ?? source.rest, target.prefix[index] ?? target.rest, depth + 1)
      )
        return false;
    return source.high <= length || subset(source.rest, target.rest, depth + 1);
  }
  if (
    x.type === 'object' &&
    y.type === 'object' &&
    minimal(x, objectKeys) &&
    minimal(y, objectKeys)
  ) {
    const source = objectModel(x),
      target = objectModel(y);
    if (source.empty) return true;
    if (
      target.empty ||
      source.low < (y.minProperties ?? 0) ||
      source.high > (y.maxProperties ?? Infinity) ||
      ![...target.required].every((key) => source.required.has(key))
    )
      return false;
    for (const [trigger, needed] of Object.entries(object(y.dependentRequired))) {
      const conditional = objectModel(x, [trigger]);
      if (!conditional.empty && !needed.every((key) => conditional.required.has(key))) return false;
    }
    const keys = new Set([...Object.keys(source.properties), ...Object.keys(target.properties)]);
    let unlisted = '__paritydiff_unlisted';
    while (keys.has(unlisted) || Object.hasOwn(object(x.dependentRequired), unlisted))
      unlisted += '_';
    if (
      !objectModel(x, [unlisted]).empty &&
      !subset(source.additional, target.additional, depth + 1)
    )
      return false;
    return [...keys].every(
      (key) =>
        objectModel(x, [key]).empty ||
        subset(
          property(source.properties, key, source.additional),
          property(target.properties, key, target.additional),
          depth + 1,
        ),
    );
  }
  return (
    !opaque && logicalSubset(a, b, (left, right) => subset(left, right, depth + 1, true), canonical)
  );
}
function exampleSeed(schema, candidates) {
  const node = object(schema);
  return (
    candidates.find((value) => {
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
      if (
        types.length &&
        !types.includes(type) &&
        !(types.includes('integer') && Number.isInteger(value))
      )
        return false;
      if (
        typeof value === 'number' &&
        (value < (node.minimum ?? -Infinity) ||
          value > (node.maximum ?? Infinity) ||
          value <= (node.exclusiveMinimum ?? -Infinity) ||
          value >= (node.exclusiveMaximum ?? Infinity))
      )
        return false;
      if (
        typeof value === 'string' &&
        (value.length < (node.minLength ?? 0) || value.length > (node.maxLength ?? Infinity))
      )
        return false;
      if (Object.hasOwn(node, 'const') && JSON.stringify(node.const) !== JSON.stringify(value))
        return false;
      if (
        node.enum &&
        !node.enum.some((member) => JSON.stringify(member) === JSON.stringify(value))
      )
        return false;
      return true;
    }) ?? null
  );
}
function examples(schema, depth = 0) {
  if (depth > 8) return [];
  const node = object(schema),
    values = [
      null,
      false,
      true,
      0,
      1,
      0.5,
      -1,
      '',
      'a',
      'aa',
      [],
      {},
      ...Object.values(object(node.properties))
        .flatMap((child) => examples(child, depth + 1))
        .slice(0, 8),
    ];
  const domain = finite(schema);
  if (domain) values.push(...domain);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
    if (typeof node[key] === 'number')
      values.push(node[key], node[key] + 1, node[key] - 1, node[key] + 0.5);
  for (const key of ['minLength', 'maxLength'])
    if (Number.isSafeInteger(node[key]) && node[key] >= 0 && node[key] <= 1000)
      values.push(
        'a'.repeat(node[key]),
        'a'.repeat(node[key] + 1),
        'a'.repeat(Math.max(0, node[key] - 1)),
      );
  if (node.type === 'array') {
    const lengths = new Set([0, 1, 2]);
    for (const key of ['minItems', 'maxItems', 'minContains', 'maxContains'])
      if (Number.isSafeInteger(node[key]))
        for (const delta of [-1, 0, 1])
          if (node[key] + delta >= 0 && node[key] + delta <= 128) lengths.add(node[key] + delta);
    const members = [
      ...(node.contains !== undefined
        ? [exampleSeed(node.contains, examples(node.contains, depth + 1))]
        : []),
      ...examples(node.items, depth + 1),
    ].slice(0, 16);
    const prefixes = (node.prefixItems ?? []).map((child) =>
      examples(child, depth + 1).slice(0, 16),
    );
    if (prefixes.length <= 128)
      for (const length of [prefixes.length - 1, prefixes.length, prefixes.length + 1])
        if (length >= 0 && length <= 128) lengths.add(length);
    for (const length of lengths) {
      for (const member of members) values.push(Array.from({ length }, () => member));
      if (members.length)
        values.push(Array.from({ length }, (_, index) => members[index % members.length]));
      const seed = Array.from({ length }, (_, index) =>
        exampleSeed(node.prefixItems?.[index] ?? node.items, prefixes[index] ?? members),
      );
      values.push(seed);
      for (let index = 0; index < length && values.length < 512; index++)
        for (const member of prefixes[index] ?? members) {
          if (values.length >= 512) break;
          const variant = [...seed];
          variant[index] = member;
          values.push(variant);
        }
      for (let choice = 0; choice < 16; choice++)
        values.push(
          Array.from({ length }, (_, index) => {
            const candidates = prefixes[index] ?? members;
            return candidates[choice % candidates.length] ?? null;
          }),
        );
    }
  }
  if (node.type === 'object') {
    const properties = object(node.properties),
      keys = node.required ?? [],
      row = Object.fromEntries(
        keys.map((key) => [
          key,
          examples(properties[key], depth + 1).find((value) => value !== null) ?? null,
        ]),
      );
    values.push(row, { ...row, synthetic_unlisted_property: true });
    for (const [key, child] of Object.entries(properties))
      for (const value of examples(child, depth + 1).slice(0, 12))
        values.push(Object.fromEntries([...Object.entries(row), [key, value]]));
  }
  for (const key of ['anyOf', 'allOf', 'oneOf'])
    if (Array.isArray(node[key]))
      values.push(...node[key].flatMap((child) => examples(child, depth + 1)));
  return [...new Map(values.slice(0, 512).map((value) => [JSON.stringify(value), value])).values()];
}
export function dialectSchema(value, openapi30, role = 'schema', legacyArrays = false, nodeOnly = false) {
  if (role === 'literal') return value;
  if (Array.isArray(value))
    return value.map((child) => dialectSchema(child, openapi30, role, legacyArrays));
  if (!value || typeof value !== 'object') return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      nodeOnly
        ? child
        : dialectSchema(
            child,
            openapi30,
            role === 'map'
              ? 'schema'
              : literals.has(key)
                ? 'literal'
                : maps.has(key)
                  ? 'map'
                  : 'schema',
            legacyArrays,
          ),
    ]),
  );
  if (role === 'schema' && legacyArrays) {
    if (Array.isArray(node.items)) {
      node.prefixItems = node.items;
      node.items = node.additionalItems ?? true;
    }
    delete node.additionalItems;
  }
  if (role === 'schema' && openapi30) {
    if (node.exclusiveMinimum === true && typeof node.minimum === 'number') {
      node.exclusiveMinimum = node.minimum;
      delete node.minimum;
    } else if (typeof node.exclusiveMinimum === 'boolean') delete node.exclusiveMinimum;
    if (node.exclusiveMaximum === true && typeof node.maximum === 'number') {
      node.exclusiveMaximum = node.maximum;
      delete node.maximum;
    } else if (typeof node.exclusiveMaximum === 'boolean') delete node.exclusiveMaximum;
    if (node.nullable === true && typeof node.type === 'string') node.type = [node.type, 'null'];
    delete node.nullable;
  }
  return node;
}
export function nativeCompiler(schema, resources = [], declaredDialect, options = {}) {
  const dialect =
    object(schema).$schema ?? declaredDialect ?? 'https://json-schema.org/draft/2020-12/schema';
  return createSchemaEngine(dialect, dialectSchema, options).compile(schema, resources);
}
export function validateCompoundSchemaResources(schema, resources = [], declaredDialect) {
  const dialect =
    object(schema).$schema ?? declaredDialect ?? 'https://json-schema.org/draft/2020-12/schema';
  const graph = schemaResourceGraph(schema, resources, dialect, {
    allowUnresolvedReferences: true,
  });
  const engines = new Map();
  for (const context of graph.contexts) {
    if (!engines.has(context.dialect))
      engines.set(context.dialect, createSchemaEngine(context.dialect, dialectSchema));
    engines.get(context.dialect).validateSchema(resourceSchemaShape(context));
  }
  return true;
}
export function compiler(schema, resources = [], declaredDialect, options = {}) {
  const dialect =
    object(schema).$schema ?? declaredDialect ?? 'https://json-schema.org/draft/2020-12/schema';
  return resourceCompiler(schema, resources, dialect, options);
}
export function resourceCompiler(
  schema,
  resources = [],
  dialect = object(schema).$schema ?? 'https://json-schema.org/draft/2020-12/schema',
  options = {},
) {
  const engines = new Map();
  return compoundCompiler(schema, resources, dialect, (selected) => {
    if (!engines.has(selected))
      engines.set(selected, createSchemaEngine(selected, dialectSchema, options));
    return engines.get(selected);
  });
}
function proofSchema(
  schema,
  resources,
  base = '',
  seen = new Set(),
  depth = 0,
  role = 'schema',
  ignoreRefSiblings = false,
) {
  if (depth > 24) throw new Error('proof_depth_limit');
  if (role === 'literal') return schema;
  if (Array.isArray(schema))
    return schema.map((child) =>
      proofSchema(child, resources, base, seen, depth + 1, role, ignoreRefSiblings),
    );
  if (!schema || typeof schema !== 'object') return schema;
  const node = schema;
  if (role === 'map')
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        proofSchema(value, resources, base, seen, depth + 1, 'schema', ignoreRefSiblings),
      ]),
    );
  if (
    typeof node.$id === 'string' &&
    !(depth > 0 && ignoreRefSiblings && typeof node.$ref === 'string')
  )
    base = new URL(node.$id, base || 'https://paritydiff.invalid/root').href;
  if (typeof node.$ref === 'string') {
    const absolute = new URL(node.$ref, base || 'https://paritydiff.invalid/root').href;
    if (seen.has(absolute)) throw new Error('recursive_proof_requires_solver');
    const uri = new URL(absolute),
      fragment = uri.hash;
    uri.hash = '';
    const find = (entry, parent) => {
      if (!entry || typeof entry !== 'object') return undefined;
      const scope =
        typeof entry.$id === 'string'
          ? new URL(entry.$id, parent || 'https://paritydiff.invalid/root').href
          : parent;
      if (scope === uri.href) return { entry, scope };
      if (
        fragment &&
        !fragment.startsWith('#/') &&
        scope === uri.href &&
        '#' + entry.$anchor === fragment
      )
        return { entry, scope };
      for (const key of ['$defs', 'definitions'])
        for (const child of Object.values(object(entry[key]))) {
          const result = find(child, scope);
          if (result) return result;
        }
      return undefined;
    };
    const resource = resources.map((resource) => find(resource, '')).find(Boolean);
    if (!resource) throw new Error('proof_resource_unavailable');
    let target = resource.entry;
    if (fragment) {
      if (!fragment.startsWith('#/')) throw new Error('anchor_proof_unavailable');
      for (const part of decodeURIComponent(fragment.slice(2)).split('/'))
        target = object(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    const next = new Set(seen);
    next.add(absolute);
    const expanded = proofSchema(
      target,
      resources,
      resource.scope,
      next,
      depth + 1,
      'schema',
      ignoreRefSiblings,
    );
    if (ignoreRefSiblings) return expanded;
    const siblings = Object.fromEntries(
      Object.entries(node).filter(([key]) => !['$ref', '$id', '$schema'].includes(key)),
    );
    return Object.keys(siblings).length
      ? {
          allOf: [
            expanded,
            proofSchema(siblings, resources, base, seen, depth + 1, 'schema', ignoreRefSiblings),
          ],
        }
      : expanded;
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !['$id', '$schema'].includes(key))
      .map(([key, value]) => [
        key,
        proofSchema(
          value,
          resources,
          base,
          seen,
          depth + 1,
          literals.has(key) ? 'literal' : maps.has(key) ? 'map' : 'schema',
          ignoreRefSiblings,
        ),
      ]),
  );
}
export function compareSchemas(input) {
  const { before, after, resources = [] } = input;
  try {
    if (before === undefined || after === undefined)
      return {
        status: 'undetermined',
        reason: 'schema_missing',
        beforeSubsetAfter: 'unknown',
        afterSubsetBefore: 'unknown',
      };
    const formatPolicy = input.formatAssertions ?? 'dialect';
    const a = compiler(before, input.beforeResources ?? resources, input.beforeDialect, {
        formatAssertions: formatPolicy,
      }),
      b = compiler(after, input.afterResources ?? resources, input.afterDialect, {
        formatAssertions: formatPolicy,
      });
    const beforeDialect =
      object(before).$schema ??
      input.beforeDialect ??
      'https://json-schema.org/draft/2020-12/schema';
    const afterDialect =
      object(after).$schema ?? input.afterDialect ?? 'https://json-schema.org/draft/2020-12/schema';
    const ignoresSiblings = (dialect) =>
      dialect === 'openapi3.0' || Boolean(legacySchemaDialect(dialect));
    let proofBefore = before,
      proofAfter = after,
      proofAvailable = true;
    try {
      proofBefore = resourceDispatchRequired(
        before,
        input.beforeResources ?? resources,
        beforeDialect,
      )
        ? expandCompoundProof(
            before,
            input.beforeResources ?? resources,
            beforeDialect,
            dialectSchema,
            { formatAssertions: formatPolicy },
          )
        : proofSchema(
            dialectSchema(before, beforeDialect === 'openapi3.0'),
            input.beforeResources ?? resources,
            '',
            new Set(),
            0,
            'schema',
            ignoresSiblings(beforeDialect),
          );
      proofAfter = resourceDispatchRequired(after, input.afterResources ?? resources, afterDialect)
        ? expandCompoundProof(
            after,
            input.afterResources ?? resources,
            afterDialect,
            dialectSchema,
            { formatAssertions: formatPolicy },
          )
        : proofSchema(
            dialectSchema(after, afterDialect === 'openapi3.0'),
            input.afterResources ?? resources,
            '',
            new Set(),
            0,
            'schema',
            ignoresSiblings(afterDialect),
          );
      const usesLegacyArrays = (dialect) =>
        Boolean(legacySchemaDialect(dialect)) ||
        dialect === 'https://json-schema.org/draft/2019-09/schema';
      proofBefore = dialectSchema(
        proofBefore,
        false,
        'schema',
        usesLegacyArrays(beforeDialect) &&
          !resourceDispatchRequired(before, input.beforeResources ?? resources, beforeDialect),
      );
      proofAfter = dialectSchema(
        proofAfter,
        false,
        'schema',
        usesLegacyArrays(afterDialect) &&
          !resourceDispatchRequired(after, input.afterResources ?? resources, afterDialect),
      );
      proofBefore = primitiveConjunction(proofBefore);
      proofAfter = primitiveConjunction(proofAfter);
      const annotationsOnly = (node, role = 'schema') => {
        if (!node || typeof node !== 'object' || role === 'literal') return node;
        if (Array.isArray(node)) return node.map((child) => annotationsOnly(child, role));
        return Object.fromEntries(
          Object.entries(node)
            .filter(([key]) => role !== 'schema' || key !== 'format')
            .map(([key, child]) => [
              key,
              annotationsOnly(
                child,
                role === 'map'
                  ? 'schema'
                  : literals.has(key)
                    ? 'literal'
                    : maps.has(key)
                      ? 'map'
                      : 'schema',
              ),
            ]),
        );
      };
      if (
        !resourceDispatchRequired(before, input.beforeResources ?? resources, beforeDialect) &&
        !schemaFormatAssertions(beforeDialect, formatPolicy)
      )
        proofBefore = annotationsOnly(proofBefore);
      if (
        !resourceDispatchRequired(after, input.afterResources ?? resources, afterDialect) &&
        !schemaFormatAssertions(afterDialect, formatPolicy)
      )
        proofAfter = annotationsOnly(proofAfter);
    } catch {
      proofAvailable = false;
    }
    const domainA = proofAvailable ? finite(proofBefore) : undefined,
      domainB = proofAvailable ? finite(proofAfter) : undefined;
    const sameResources =
      beforeDialect === afterDialect &&
      JSON.stringify(canonical(input.beforeResources ?? resources)) ===
        JSON.stringify(canonical(input.afterResources ?? resources));
    const referenceOptions = {
      beforeResources: input.beforeResources ?? resources,
      afterResources: input.afterResources ?? resources,
      beforeDialect,
      afterDialect,
      ignoreRefSiblings: ignoresSiblings(beforeDialect),
      formatAssertions: formatPolicy,
    };
    const sameReferenceGraph =
      compoundReferenceEquivalent(before, after, referenceOptions, canonical) ||
      referenceEquivalent(before, after, referenceOptions, canonical);
    const structuralSubset = (source, target, options) =>
      recursiveContainment(
        source,
        target,
        options,
        (left, right) => subset(primitiveConjunction(left), primitiveConjunction(right)),
        dialectSchema,
      ) ||
      conjunctiveContainment(
        source,
        target,
        options,
        (left, right) => subset(primitiveConjunction(left), primitiveConjunction(right)),
        dialectSchema,
      );
    const witnesses = {};
    const patternCandidates = [];
    if (proofAvailable)
      for (const [source, target] of [
        [proofBefore, proofAfter],
        [proofAfter, proofBefore],
      ]) {
        if (object(source).type === 'string' && object(target).type === 'string') {
          const candidate = patternWitness(
            source.pattern,
            target.pattern,
            source.minLength ?? 0,
            source.maxLength ?? Infinity,
          );
          if (candidate !== undefined) patternCandidates.push(candidate);
        }
      }
    const checkWitness = (value) => {
      const old = a(value),
        next = b(value);
      if (old && !next && !Object.hasOwn(witnesses, 'beforeOnly')) witnesses.beforeOnly = value;
      if (next && !old && !Object.hasOwn(witnesses, 'afterOnly')) witnesses.afterOnly = value;
    };
    for (const value of [
      ...patternCandidates,
      ...examples(proofBefore),
      ...examples(proofAfter),
      ...(input.beforeResources ?? resources).flatMap((resource) => examples(resource)),
      ...(input.afterResources ?? resources).flatMap((resource) => examples(resource)),
    ])
      checkWitness(value);
    const proofAB = Object.hasOwn(witnesses, 'beforeOnly')
      ? false
      : domainA
        ? domainA.filter((v) => a(v)).every((v) => b(v))
        : sameReferenceGraph ||
            (proofAvailable && subset(proofBefore, proofAfter)) ||
            structuralSubset(before, after, referenceOptions) ||
            (sameResources && JSON.stringify(before) === JSON.stringify(after))
          ? true
          : 'unknown';
    const proofBA = Object.hasOwn(witnesses, 'afterOnly')
      ? false
      : domainB
        ? domainB.filter((v) => b(v)).every((v) => a(v))
        : sameReferenceGraph ||
            (proofAvailable && subset(proofAfter, proofBefore)) ||
            structuralSubset(after, before, {
              ...referenceOptions,
              beforeResources: referenceOptions.afterResources,
              afterResources: referenceOptions.beforeResources,
              beforeDialect: afterDialect,
              afterDialect: beforeDialect,
            }) ||
            (sameResources && JSON.stringify(before) === JSON.stringify(after))
          ? true
          : 'unknown';
    if (proofAB === 'unknown' || proofBA === 'unknown') {
      for (const [schema, schemas, dialect, other] of [
        [before, input.beforeResources ?? resources, beforeDialect, b],
        [after, input.afterResources ?? resources, afterDialect, a],
      ]) {
        const comparisonPatterns = [
          ...new Set(
            other.graph.contexts.flatMap((context) => [
              ...(context.maps.patternProperties?.keys() ?? []),
            ]),
          ),
        ];
        for (const value of compoundWitnessCandidates(
          schema,
          schemas,
          dialect,
          dialectSchema,
          examples,
          exampleSeed,
          comparisonPatterns,
        ))
          checkWitness(value);
        if (
          (proofAB !== 'unknown' || Object.hasOwn(witnesses, 'beforeOnly')) &&
          (proofBA !== 'unknown' || Object.hasOwn(witnesses, 'afterOnly'))
        )
          break;
      }
    }
    const ab = Object.hasOwn(witnesses, 'beforeOnly') ? false : proofAB;
    const ba = Object.hasOwn(witnesses, 'afterOnly') ? false : proofBA;
    return {
      status:
        ab === true && ba === true
          ? 'equivalent'
          : ab === false || ba === false
            ? 'different'
            : 'undetermined',
      beforeSubsetAfter: ab,
      afterSubsetBefore: ba,
      reason:
        ab === true && ba === true
          ? 'bidirectional_containment_proved'
          : Object.keys(witnesses).length
            ? 'validated_counterexample'
            : 'containment_needs_additional_proof',
      witnesses,
      profile: {
        scope: 'json_schema_instance_validation',
        dialect:
          object(before).$schema ??
          input.beforeDialect ??
          'https://json-schema.org/draft/2020-12/schema',
        afterDialect:
          object(after).$schema ??
          input.afterDialect ??
          'https://json-schema.org/draft/2020-12/schema',
        formatAssertions: schemaFormatAssertions(beforeDialect, formatPolicy),
        afterFormatAssertions: schemaFormatAssertions(afterDialect, formatPolicy),
        formatMode: formatPolicy,
        finiteDomainLimit: 256,
        regularExpressionProof: patternProofProfile(),
        referenceProof: {
          equivalent: sameReferenceGraph,
          nodeLimit: 4096,
          stepLimit: 20000,
          recursion: 'instance_guarded_resource_and_dynamic_scope_graph',
          containment: 'scoped_conjunction_and_boolean_obligations_with_evaluated_locations',
          counterexampleSearch: { instanceDepth: 4, candidateLimit: 512, nodeLimit: 10000 },
        },
        conjunctiveProof: {
          nodeLimit: 4096,
          stepLimit: 20000,
          depthLimit: 256,
          jointBooleanAtomLimit: 2,
          annotationSuccessSetBranchLimit: 3,
          annotationSuccessSetCaseLimit: 7,
          annotationActivationVisitLimit: 64,
          conditionalAnnotations: 'exact_success_and_trigger_cases',
          closedContainsItems: 'resource_dialect_and_match_cardinality',
          annotationSensitiveBoolean: 'scoped_structural_obligations',
          unresolvedPredicates: 'undetermined',
        },
        logicalProof: {
          atomLimit: 16,
          nodeLimit: 4096,
          stepLimit: 32768,
          unresolvedPredicates: 'opaque',
        },
      },
    };
  } catch {
    return {
      status: 'undetermined',
      reason: 'dialect_or_schema_validation_unavailable',
      beforeSubsetAfter: 'unknown',
      afterSubsetBefore: 'unknown',
    };
  }
}
