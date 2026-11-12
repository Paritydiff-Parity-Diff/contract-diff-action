import { contentHash, legacySchemaDialect } from '@paritydiff/core';
import { contractChildRole, type ContractRole } from './contract-tree';

const DEFAULT_MAX_REF_DEPTH = 100;

export interface NormalizeOptions {
  // Exact key names stripped anywhere in the tree (x- extensions, generation
  // timestamps, templated server urls) - supplied per vendor (spec section 9.1).
  readonly volatileFields?: readonly string[];
  readonly maxRefDepth?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly referenceRoot?: unknown;
}

export interface NormalizedSpec {
  readonly document: unknown;
  readonly hash: string;
}

// Canonicalize a parsed spec so that a re-serialized-but-equal document produces
// the same identity hash: inline local $refs (cycle-safe), strip volatile keys,
// fold OAS 3.0/3.1 nullable differences, and sort keys at every depth.
export function normalizeSpec(input: unknown, options: NormalizeOptions = {}): NormalizedSpec {
  const volatile = new Set(options.volatileFields ?? []);
  const limits = { depth: options.maxDepth ?? 128, remaining: options.maxNodes ?? 200000 };
  const source = options.referenceRoot ?? input;
  const root =
    source && typeof source === 'object' ? (source as Record<string, unknown>) : undefined;
  const inheritedDialect =
    root?.['$schema'] ??
    root?.['jsonSchemaDialect'] ??
    (String(root?.['openapi']).startsWith('3.0') || root?.['swagger'] === '2.0'
      ? 'openapi3.0'
      : undefined);
  const inlined = inlineRefs(
    input,
    source,
    options.maxRefDepth ?? DEFAULT_MAX_REF_DEPTH,
    [],
    limits,
    0,
    'structure',
    typeof inheritedDialect === 'string' ? inheritedDialect : undefined,
    typeof root?.['$schema'] === 'string',
  );
  const version = root?.['openapi'];
  const dialect = root?.['$schema'];
  const canonical = transform(
    inlined,
    volatile,
    !/^3\.[12]\./.test(String(version)) && dialect === undefined,
  );
  return { document: canonical, hash: contentHash(canonical) };
}

function inlineRefs(
  node: unknown,
  root: unknown,
  budget: number,
  stack: readonly string[],
  limits: { depth: number; remaining: number },
  depth: number,
  role: ContractRole = 'structure',
  dialect?: string,
  schema = false,
): unknown {
  if (depth > limits.depth || --limits.remaining < 0) throw new Error('spec_normalization_limit');
  if (Array.isArray(node))
    return node.map((child) =>
      inlineRefs(child, root, budget, stack, limits, depth + 1, role, dialect, schema),
    );
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (role === 'structure' && typeof obj['$schema'] === 'string') {
      dialect = obj['$schema'];
      schema = true;
    }
    const ref = obj['$ref'];
    let decodedRef: string | undefined;
    if (role === 'structure' && typeof ref === 'string' && ref.startsWith('#')) {
      try {
        decodedRef = decodeURIComponent(ref);
      } catch {
        decodedRef = undefined;
      }
    }
    if (decodedRef === '#' || decodedRef?.startsWith('#/')) {
      const target = resolvePointer(root, decodedRef, dialect);
      const resolved =
        stack.includes(decodedRef) || budget <= 0
          ? { $circular: decodedRef }
          : target.value === undefined
            ? { $unresolved: ref }
            : inlineRefs(
                target.value,
                root,
                budget - 1,
                [...stack, decodedRef],
                limits,
                depth + 1,
                role,
                target.dialect,
                schema,
              );
      if (schema && (legacySchemaDialect(dialect) || dialect === 'openapi3.0')) return resolved;
      const siblings = Object.fromEntries(Object.entries(obj).filter(([key]) => key !== '$ref'));
      if (Object.keys(siblings).length === 0) return resolved;
      return {
        allOf: [
          resolved,
          inlineRefs(siblings, root, budget, stack, limits, depth + 1, role, dialect, schema),
        ],
      };
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(obj))
      out[key] = inlineRefs(
        value,
        root,
        budget,
        stack,
        limits,
        depth + 1,
        schema && role === 'structure' && key === 'examples'
          ? 'literal'
          : contractChildRole(role, key),
        dialect,
        schema || (role === 'structure' && (key === 'schema' || key === 'schemas')),
      );
    return out;
  }
  return node;
}

function resolvePointer(
  root: unknown,
  ref: string,
  dialect?: string,
): { value: unknown; dialect?: string } {
  const parts =
    ref === '#'
      ? []
      : ref
          .slice(2)
          .split('/')
          .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  let role: ContractRole = 'structure';
  for (const part of parts) {
    if (current !== null && typeof current === 'object') {
      const node = current as Record<string, unknown>;
      if (role === 'structure') {
        if (typeof node['$schema'] === 'string') dialect = node['$schema'];
        else if (typeof node['jsonSchemaDialect'] === 'string') dialect = node['jsonSchemaDialect'];
      }
      role =
        part === 'x-paritydiff-reference-documents' ? 'members' : contractChildRole(role, part);
      current = Object.hasOwn(current, part)
        ? (current as Record<string, unknown>)[part]
        : undefined;
    } else {
      return { value: undefined, ...(dialect ? { dialect } : {}) };
    }
  }
  return { value: current, ...(dialect ? { dialect } : {}) };
}

function transform(
  node: unknown,
  volatile: Set<string>,
  foldNullable: boolean,
  role: ContractRole = 'structure',
): unknown {
  if (Array.isArray(node))
    return node.map((child) => transform(child, volatile, foldNullable, role));
  if (node !== null && typeof node === 'object') {
    const normalized =
      foldNullable && role === 'structure'
        ? normalizeNullable(node as Record<string, unknown>)
        : (node as Record<string, unknown>);
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(normalized).sort()) {
      if (volatile.has(key)) continue;
      const value = transform(
        normalized[key],
        volatile,
        foldNullable,
        contractChildRole(role, key),
      );
      out[key] =
        role === 'structure' &&
        ['allOf', 'anyOf', 'oneOf', 'required', 'enum', 'type'].includes(key) &&
        Array.isArray(value)
          ? [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
          : value;
    }
    return out;
  }
  return node;
}

// Fold the two nullable spellings together: OAS 3.1 `type: [T, "null"]` becomes
// the OAS 3.0 `type: T, nullable: true`; a redundant `nullable: false` is dropped.
function normalizeNullable(obj: Record<string, unknown>): Record<string, unknown> {
  const type = obj['type'];
  if (Array.isArray(type) && type.includes('null')) {
    const nonNull = type.filter((t) => t !== 'null');
    return { ...obj, type: nonNull.length === 1 ? nonNull[0] : nonNull, nullable: true };
  }
  if (obj['nullable'] === false) {
    const { nullable: _drop, ...rest } = obj;
    return rest;
  }
  return obj;
}
