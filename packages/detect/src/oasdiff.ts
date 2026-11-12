import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type OasdiffChange, type Result } from '@paritydiff/core';
import { supplementContractChanges } from './contract-coverage';
import { supplementSemanticEvidence } from './semantic-evidence';
import { compactComparisonPair } from './compact-comparison';

const execFileAsync = promisify(execFile);

// Pinned by immutable digest so a re-run reproduces byte-for-byte and a version
// bump is a deliberate, reviewable change (spec section 5.2).
export const OASDIFF_IMAGE =
  'tufin/oasdiff@sha256:6065c16a4c9ce12504752f444d4981091e58c2a35436fac90b649be47d833db3';

export type OasdiffError = {
  readonly kind: 'oasdiff_failed' | 'invalid_contract';
  readonly message: string;
};

// Cap the diff container's memory so one pathological spec cannot exhaust the host.
// Equal --memory/--memory-swap disables swap for the container, so it is OOM-killed
// cleanly (docker exits non-zero -> oasdiff_failed -> caller records hash_only)
// instead of thrashing the box into swap. The limit is injected by callers (an app
// may override it from config/env); the package never reads env (spec section 6).
export const DEFAULT_OASDIFF_MEMORY = '2g';

// docker argv for one changelog run. Kept pure so the isolation flags are unit-tested
// without invoking Docker.
export function oasdiffArgs(
  dir: string,
  image = OASDIFF_IMAGE,
  memory = DEFAULT_OASDIFF_MEMORY,
  cgroupParent?: string,
): string[] {
  return [
    'run',
    '--rm',
    ...(cgroupParent ? ['--cgroup-parent', cgroupParent] : []),
    '--network',
    'none',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '-v',
    `${dir}:/specs:ro`,
    image,
    'changelog',
    '-f',
    'json',
    '/specs/base.json',
    '/specs/revision.json',
  ];
}

// OpenAPI fields that must be strings; an unresolved external $ref lands here as an
// object and oasdiff refuses to load the spec (seen with DigitalOcean).
const STRING_FIELDS = new Set(['description', 'summary', 'title']);

// Keywords whose direct children are arbitrary member names (property/schema names),
// not OpenAPI fields - so a member literally named "description" is a schema, not a
// string field, and must not be coerced (that broke Asana, whose schemas have such
// properties). Coercion is suppressed for the direct children of these.
const MEMBER_MAPS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'schemas',
  'examples',
]);

// Neutralise refs oasdiff cannot resolve under --network none. Normalisation already
// inlined local (#/) refs, so any ref left here points at an external file we never
// fetched; leaving the bare {$ref} object makes the doc invalid OpenAPI. Replace it
// with an empty (permissive) schema, and coerce a string-only field that thereby
// became an object back to a string. Applied only for the diff, so stored spec hashes
// and release detection are unchanged.
export function sanitizeForOasdiff(node: unknown): unknown {
  return sanitizeNode(node, false);
}

function sanitizeNode(node: unknown, keysAreMembers: boolean): unknown {
  if (Array.isArray(node)) return node.map((child) => sanitizeNode(child, false));
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && !ref.startsWith('#/')) return {};
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(obj)) {
      const clean = sanitizeNode(value, MEMBER_MAPS.has(key));
      const coerce =
        !keysAreMembers && STRING_FIELDS.has(key) && typeof clean === 'object' && clean !== null;
      out[key] = coerce ? '' : clean;
    }
    return out;
  }
  return node;
}

function sanitizeSpecDocument(spec: unknown): string {
  return JSON.stringify(sanitizeForOasdiff(spec));
}

// Runs oasdiff in a one-shot, network-isolated container with an argv array (no
// shell) and a read-only mount (spec section 4 row 5, section 13). Input specs
// are written to a private temp dir that is removed afterwards.
export async function runOasdiffChangelog(
  baseSpec: string,
  revisionSpec: string,
  image = OASDIFF_IMAGE,
  memory = DEFAULT_OASDIFF_MEMORY,
  cgroupParent?: string,
): Promise<Result<OasdiffChange[], OasdiffError>> {
  const dir = await mkdtemp(join(tmpdir(), 'oasdiff-'));
  try {
    const documents: unknown[] = [];
    for (const [side, source] of [
      ['base', baseSpec],
      ['revision', revisionSpec],
    ] as const) {
      if (Buffer.byteLength(source) > 128 * 1024 * 1024) throw new Error('comparison_input_limit');
      let doc: unknown;
      try {
        doc = JSON.parse(source);
      } catch {
        return err({ kind: 'invalid_contract', message: side + ': invalid stored JSON' });
      }
      const root =
        doc && typeof doc === 'object' && !Array.isArray(doc)
          ? (doc as Record<string, unknown>)
          : undefined;
      if (
        !root ||
        typeof root['openapi'] !== 'string' ||
        (root['paths'] !== undefined &&
          (!root['paths'] || typeof root['paths'] !== 'object' || Array.isArray(root['paths'])))
      )
        return err({
          kind: 'invalid_contract',
          message: side + ': invalid OpenAPI document or paths map',
        });
      documents.push(doc);
    }
    const [before, after] = documents;
    const [engineBefore, engineAfter] = compactComparisonPair(before, after);
    await writeFile(join(dir, 'base.json'), sanitizeSpecDocument(engineBefore));
    await writeFile(join(dir, 'revision.json'), sanitizeSpecDocument(engineAfter));
    const { stdout } = await execFileAsync(
      'docker',
      oasdiffArgs(dir, image, memory, cgroupParent),
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
      },
    );
    const trimmed = stdout.trim();
    const parsed = trimmed === '' ? [] : (JSON.parse(trimmed) as OasdiffChange[]);
    return ok(
      await supplementSemanticEvidence(
        before,
        after,
        supplementContractChanges(before, after, parsed),
      ),
    );
  } catch (cause) {
    return err({
      kind: 'oasdiff_failed',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
