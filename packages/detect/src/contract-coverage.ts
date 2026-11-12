import type { OasdiffChange } from '@paritydiff/core';
import { normalizeSpec } from './normalize';
import { nativeHttpChanges } from './native-http-changes';
import { asyncapiChanges } from './asyncapi-changes';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'query'];

function coversRequirement(next: unknown, old: unknown): boolean {
  const required = obj(next),
    previous = obj(old);
  return Object.entries(required).every(
    ([scheme, scopes]) =>
      Object.hasOwn(previous, scheme) &&
      Array.isArray(scopes) &&
      Array.isArray(previous[scheme]) &&
      scopes.every((scope) => (previous[scheme] as unknown[]).includes(scope)),
  );
}

function disjoint(a: unknown, b: unknown): boolean {
  const ap = obj(obj(a)['properties']),
    bp = obj(obj(b)['properties']);
  const ar = obj(a)['required'],
    br = obj(b)['required'];
  if (!Array.isArray(ar) || !Array.isArray(br)) return false;
  return ar.some((key) => {
    if (typeof key !== 'string' || !br.includes(key)) return false;
    const x = obj(ap[key]),
      y = obj(bp[key]);
    const xv = Array.isArray(x['enum']) ? x['enum'] : Object.hasOwn(x, 'const') ? [x['const']] : [];
    const yv = Array.isArray(y['enum']) ? y['enum'] : Object.hasOwn(y, 'const') ? [y['const']] : [];
    return xv.length > 0 && yv.length > 0 && xv.every((v) => !yv.some((w) => equal(v, w)));
  });
}

// Supplement the pinned engine's known omissions without changing its output.
export function supplementContractChanges(
  before: unknown,
  after: unknown,
  feed: readonly OasdiffChange[],
): OasdiffChange[] {
  const out = [...feed];
  for (const change of [...nativeHttpChanges(before, after), ...asyncapiChanges(before, after)])
    if (
      !out.some(
        (existing) =>
          existing.id === change.id &&
          existing.path === change.path &&
          existing.fingerprint === change.fingerprint,
      )
    )
      out.push(change);
  const pathsA = obj(obj(before)['paths']),
    pathsB = obj(obj(after)['paths']);
  for (const path of Object.keys(pathsB)) {
    let oldPath = pathsA[path],
      nextPath = pathsB[path];
    let bounded = false;
    try {
      if (oldPath !== undefined)
        oldPath = normalizeSpec(oldPath, { referenceRoot: before }).document;
      if (nextPath !== undefined)
        nextPath = normalizeSpec(nextPath, { referenceRoot: after }).document;
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== 'spec_normalization_limit') throw cause;
      bounded = true;
    }
    for (const method of methods) {
      const a = obj(oldPath)[method],
        b = obj(nextPath)[method];
      const emit = (id: string, pointer: string, old: unknown, next: unknown, level: number) => {
        const fingerprint = `${id}:${pointer}:${JSON.stringify(old)}:${JSON.stringify(next)}`;
        if (
          out.some(
            (change) =>
              change.path === path &&
              change.operation?.toLowerCase() === method &&
              change.fingerprint === fingerprint,
          )
        )
          return;
        out.push({
          id,
          path,
          operation: method.toUpperCase(),
          level,
          fieldPath: pointer,
          text: `${pointer}: ${JSON.stringify(old)} -> ${JSON.stringify(next)}`,
          fingerprint,
        });
      };
      if (bounded && b) {
        emit(
          'operation-coverage-incomplete',
          '/source',
          'normalization limit',
          'Supplemental normalization exceeded its per-path budget; engine evidence retained.',
          2,
        );
        continue;
      }
      if (!a || !b) {
        if (
          b &&
          Array.isArray(obj(after)['x-paritydiff-coverage-issues']) &&
          (obj(after)['x-paritydiff-coverage-issues'] as unknown[]).length
        )
          emit(
            'operation-coverage-incomplete',
            '/source',
            null,
            obj(after)['x-paritydiff-coverage-issues'],
            2,
          );
        continue;
      }
      const issues = obj(after)['x-paritydiff-coverage-issues'];
      if (Array.isArray(issues) && issues.length)
        emit('request-coverage-incomplete', '/source', null, issues, 2);
      const oldSecurity = obj(a)['security'] ?? obj(before)['security'] ?? [];
      const newSecurity = obj(b)['security'] ?? obj(after)['security'] ?? [];
      if (
        !equal(oldSecurity, newSecurity) &&
        Array.isArray(oldSecurity) &&
        Array.isArray(newSecurity)
      ) {
        const oldOptions = oldSecurity.length ? oldSecurity : [{}],
          newOptions = newSecurity.length ? newSecurity : [{}];
        const relaxed = oldOptions.every((oldOption) =>
          newOptions.some((newOption) => coversRequirement(newOption, oldOption)),
        );
        let found = false;
        for (let i = 0; i < out.length; i++) {
          const change = out[i]!;
          if (
            /^api-security-(?:added|removed|scope-added|scope-removed)$/.test(change.id) &&
            change.path === path &&
            change.operation?.toLowerCase() === method
          ) {
            out[i] = {
              ...change,
              id: relaxed ? 'security-alternative-added' : 'security-requirement-tightened',
              level: relaxed ? 1 : 3,
            };
            found = true;
          }
        }
        if (!found)
          emit(
            relaxed ? 'security-alternative-added' : 'security-requirement-tightened',
            '/security',
            oldSecurity,
            newSecurity,
            relaxed ? 1 : 3,
          );
      }
      const walk = (
        old: unknown,
        next: unknown,
        pointer: string,
        direction: 'request' | 'response',
        depth = 0,
        role: 'container' | 'schema' | 'schema-map' = 'container',
      ): void => {
        if (equal(old, next)) return;
        if (depth > 128) {
          emit(`${direction}-coverage-incomplete`, pointer, 'depth limit', null, 2);
          return;
        }
        if (Array.isArray(old) && Array.isArray(next)) {
          for (let i = 0; i < Math.min(old.length, next.length); i++)
            walk(old[i], next[i], `${pointer}/${i}`, direction, depth + 1, role);
          return;
        }
        const x = obj(old),
          y = obj(next);
        if (role === 'schema' && (typeof old === 'boolean' || typeof next === 'boolean')) {
          const narrowing = next === false || old === true;
          emit(
            `${direction}-boolean-schema-${narrowing ? 'tightened' : 'relaxed'}`,
            pointer,
            old,
            next,
            (direction === 'request' ? narrowing : !narrowing) ? 3 : 1,
          );
          if ((old !== true && old !== false) || (next !== true && next !== false))
            emit(`${direction}-coverage-incomplete`, pointer, old, next, 2);
          return;
        }
        if (
          ['$ref', '$unresolved', '$circular'].some(
            (k) => Object.hasOwn(x, k) || Object.hasOwn(y, k),
          )
        ) {
          emit(`${direction}-coverage-incomplete`, pointer, old, next, 2);
          return;
        }
        if (role === 'schema') {
          const required = (node: Obj) =>
            new Set(
              Array.isArray(node['required'])
                ? node['required'].filter((name): name is string => typeof name === 'string')
                : [],
            );
          const previous = required(x),
            current = required(y);
          // The pinned detector follows declared properties and misses these names.
          for (const name of current)
            if (!previous.has(name) && !Object.hasOwn(obj(y['properties']), name))
              emit(
                `${direction}-property-became-required`,
                pointer + '/required/' + escape(name),
                false,
                true,
                direction === 'request' ? 3 : 1,
              );
          for (const name of previous)
            if (!current.has(name) && !Object.hasOwn(obj(x['properties']), name))
              emit(
                `${direction}-property-became-optional`,
                pointer + '/required/' + escape(name),
                true,
                false,
                direction === 'response' ? 3 : 1,
              );
        }
        for (const key of role === 'schema'
          ? [
              'maxItems',
              'minItems',
              'maxProperties',
              'minProperties',
              'uniqueItems',
              'multipleOf',
              'additionalProperties',
            ]
          : []) {
          const xv = x[key],
            yv = y[key];
          if (equal(xv, yv)) continue;
          let narrowing: boolean | undefined;
          if (['maxItems', 'minItems', 'maxProperties', 'minProperties'].includes(key)) {
            const maximum = key.startsWith('max');
            const fallback = maximum ? Infinity : 0;
            const left = typeof xv === 'number' ? xv : fallback,
              right = typeof yv === 'number' ? yv : fallback;
            narrowing = maximum ? right < left : right > left;
          } else if (key === 'uniqueItems') narrowing = yv === true;
          else if (key === 'additionalProperties') {
            if (yv === false && xv !== false) narrowing = true;
            else if (xv === false && yv !== false) narrowing = false;
            else if (typeof xv === 'object' || typeof yv === 'object') {
              emit(`${direction}-coverage-incomplete`, pointer + '/' + key, xv, yv, 2);
            }
          } else if (key === 'multipleOf') {
            if (yv === undefined) narrowing = false;
            else if (xv === undefined) narrowing = true;
            else if (typeof xv === 'number' && typeof yv === 'number' && yv % xv === 0)
              narrowing = true;
            else if (typeof xv === 'number' && typeof yv === 'number' && xv % yv === 0)
              narrowing = false;
            else {
              emit(`${direction}-multipleOf-changed`, pointer, xv, yv, 2);
            }
          }
          if (narrowing !== undefined)
            emit(
              `${direction}-${key}-${narrowing ? 'tightened' : 'relaxed'}`,
              pointer,
              xv,
              yv,
              (direction === 'request' ? narrowing : !narrowing) ? 3 : 1,
            );
        }
        const oldUnion = x['oneOf'],
          newUnion = y['oneOf'];
        if (
          role === 'schema' &&
          direction === 'response' &&
          Array.isArray(oldUnion) &&
          Array.isArray(newUnion) &&
          newUnion.length > oldUnion.length &&
          oldUnion.every((v, i) => equal(v, newUnion[i])) &&
          newUnion.every((v, i) => newUnion.slice(i + 1).every((w) => disjoint(v, w)))
        ) {
          for (let i = 0; i < out.length; i++) {
            const c = out[i]!;
            if (
              c.id === 'response-body-one-of-added' &&
              c.path === path &&
              c.operation?.toLowerCase() === method
            ) {
              out[i] = { ...c, id: 'response-disjoint-union-added', level: 1 };
            }
          }
        }
        for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
          if (
            role === 'schema' &&
            !equal(x[key], y[key]) &&
            ![
              'type',
              'format',
              'title',
              'description',
              'default',
              'example',
              'examples',
              'enum',
              'const',
              'properties',
              'required',
              'items',
              'allOf',
              'anyOf',
              'oneOf',
              'additionalProperties',
              'minLength',
              'maxLength',
              'pattern',
              'minimum',
              'maximum',
              'exclusiveMinimum',
              'exclusiveMaximum',
              'minItems',
              'maxItems',
              'minProperties',
              'maxProperties',
              'multipleOf',
              'uniqueItems',
              'nullable',
              'readOnly',
              'writeOnly',
              'deprecated',
              'discriminator',
              'xml',
              'externalDocs',
              '$schema',
              '$id',
              '$anchor',
              '$defs',
              'definitions',
            ].includes(key) &&
            !key.startsWith('x-')
          )
            emit(
              `${direction}-coverage-incomplete`,
              pointer + '/' + escape(key),
              x[key],
              y[key],
              2,
            );
          if (
            ['example', 'examples', 'default', 'enum', 'const', 'description', 'summary'].includes(
              key,
            ) ||
            key.startsWith('x-')
          )
            continue;
          const left = x[key],
            right = y[key];
          if (
            key === 'additionalProperties' &&
            (typeof left === 'boolean' ||
              typeof right === 'boolean' ||
              left === undefined ||
              right === undefined)
          )
            continue;
          const childRole =
            role === 'schema-map' ||
            key === 'schema' ||
            (role === 'schema' &&
              [
                'items',
                'additionalProperties',
                'contains',
                'not',
                'if',
                'then',
                'else',
                'allOf',
                'anyOf',
                'oneOf',
                'prefixItems',
              ].includes(key))
              ? 'schema'
              : role === 'schema' &&
                  [
                    'properties',
                    'patternProperties',
                    '$defs',
                    'definitions',
                    'dependentSchemas',
                  ].includes(key)
                ? 'schema-map'
                : 'container';
          if (Array.isArray(left) && Array.isArray(right)) {
            for (let i = 0; i < Math.min(left.length, right.length); i++)
              walk(
                left[i],
                right[i],
                `${pointer}/${escape(key)}/${i}`,
                direction,
                depth + 1,
                childRole,
              );
          } else if (
            childRole === 'schema' ||
            (left && right && typeof left === 'object' && typeof right === 'object')
          ) {
            walk(left, right, `${pointer}/${escape(key)}`, direction, depth + 1, childRole);
          }
        }
      };
      walk(obj(a)['requestBody'], obj(b)['requestBody'], '/requestBody', 'request');
      walk(obj(a)['parameters'], obj(b)['parameters'], '/parameters', 'request');
      walk(obj(a)['responses'], obj(b)['responses'], '/responses', 'response');
      if (
        !equal(
          obj(before)['x-paritydiff-native-contract'],
          obj(after)['x-paritydiff-native-contract'],
        ) ||
        !equal(
          obj(before)['x-paritydiff-graphql-scalar-contracts'],
          obj(after)['x-paritydiff-graphql-scalar-contracts'],
        )
      )
        emit(
          'operation-coverage-incomplete',
          '/native-contract',
          'native contract changed',
          'native comparison and binding evidence required',
          2,
        );
      if (
        !equal(obj(before)['webhooks'], obj(after)['webhooks']) ||
        !equal(obj(a)['callbacks'], obj(b)['callbacks']) ||
        !equal(obj(pathsA[path])['additionalOperations'], obj(pathsB[path])['additionalOperations'])
      )
        emit(
          'operation-coverage-incomplete',
          '/nonstandard-operation',
          'callback, webhook or additional operation changed',
          'native binding evidence required',
          2,
        );
    }
  }
  return out;
}
