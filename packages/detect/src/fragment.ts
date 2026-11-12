import { parse, stringify } from 'yaml';
import type { SpecFragmentLine } from '@paritydiff/core';

// Builds the path-scoped spec diff the dashboard renders as evidence. The two spec
// bodies are already in hand where oasdiff runs; here we slice out the changed path
// and diff its serialized form, so the fragment is spec-only and never the whole
// document. Returns null when the path is absent or nothing changed.

const MAX_LINES = 40;
const CONTEXT = 2;

function subtree(spec: unknown, path: string): unknown {
  if (spec === null || typeof spec !== 'object') return undefined;
  const paths = (spec as Record<string, unknown>)['paths'];
  if (paths === null || typeof paths !== 'object') return undefined;
  return (paths as Record<string, unknown>)[path];
}

function toLines(node: unknown): readonly string[] {
  if (node === undefined) return [];
  const text = typeof node === 'string' ? node : stringify(node);
  return text.replace(/\n$/, '').split('\n');
}

function lcs(from: readonly string[], to: readonly string[]): number[][] {
  const n = from.length;
  const m = to.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i] ?? [];
    const next = dp[i + 1] ?? [];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = from[i] === to[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return dp;
}

function diffLines(from: readonly string[], to: readonly string[]): SpecFragmentLine[] {
  const dp = lcs(from, to);
  const out: SpecFragmentLine[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      out.push({ kind: 'ctx', text: from[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'del', text: from[i] ?? '' });
      i += 1;
    } else {
      out.push({ kind: 'add', text: to[j] ?? '' });
      j += 1;
    }
  }
  for (; i < from.length; i += 1) out.push({ kind: 'del', text: from[i] ?? '' });
  for (; j < to.length; j += 1) out.push({ kind: 'add', text: to[j] ?? '' });
  return out;
}

// Keep only the changed lines with a little context; collapse long unchanged runs to
// a single ellipsis so the fragment stays a readable hunk.
function compact(lines: readonly SpecFragmentLine[]): SpecFragmentLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.kind === 'ctx') return;
    const lo = Math.max(0, idx - CONTEXT);
    const hi = Math.min(lines.length - 1, idx + CONTEXT);
    for (let k = lo; k <= hi; k += 1) keep[k] = true;
  });
  const out: SpecFragmentLine[] = [];
  let gap = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (!line) continue;
    if (keep[idx]) {
      out.push(line);
      gap = false;
    } else if (!gap) {
      out.push({ kind: 'ctx', text: '...' });
      gap = true;
    }
  }
  return out.slice(0, MAX_LINES);
}

export function buildSpecFragment(
  fromSpec: string,
  toSpec: string,
  path: string,
): readonly SpecFragmentLine[] | null {
  return specFragmentBuilder(fromSpec, toSpec)(path);
}

export function specFragmentBuilder(
  fromSpec: string,
  toSpec: string,
  parsed?: { from: unknown; to: unknown },
): (path: string) => readonly SpecFragmentLine[] | null {
  let from: unknown;
  let to: unknown;
  const decode = (source: string): unknown => {
    try {
      return JSON.parse(source);
    } catch {
      return parse(source);
    }
  };
  try {
    from = parsed ? parsed.from : decode(fromSpec);
    to = parsed ? parsed.to : decode(toSpec);
  } catch {
    return () => null;
  }
  const cache = new Map<string, readonly SpecFragmentLine[] | null>();
  return (path) => {
    if (cache.has(path)) return cache.get(path)!;
    const fromNode = subtree(from, path),
      toNode = subtree(to, path);
    let result: readonly SpecFragmentLine[] | null = null;
    if (
      (fromNode !== undefined || toNode !== undefined) &&
      [fromNode, toNode].every(
        (node) => Buffer.byteLength(JSON.stringify(node) ?? '') <= 128 * 1024,
      )
    ) {
      const a = toLines(fromNode),
        b = toLines(toNode);
      if (a.length <= 2000 && b.length <= 2000 && a.length * b.length <= 1000000) {
        const lines = diffLines(a, b);
        if (lines.some((line) => line.kind !== 'ctx')) result = compact(lines);
      }
    }
    cache.set(path, result);
    return result;
  };
}
