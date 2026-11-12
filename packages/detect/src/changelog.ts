import { prefixedId, type ChangeDirection, type ChangeRecord } from '@paritydiff/core';

export interface ExtractedChange {
  readonly change_type: string;
  readonly direction: ChangeDirection;
  readonly path: string;
  readonly field_path?: string;
  readonly quote: string;
}

export interface ExtractionResult {
  readonly raw: unknown;
  readonly candidates: readonly unknown[];
  readonly model: string;
  readonly modelVersion: string;
  readonly promptHash: string;
}

// The LLM is given changelog content as untrusted data and returns proposed
// changes only (D-1). It never classifies and is never the last gate. Concrete
// implementations run at temperature 0 and stamp model/version/prompt hash.
export interface LlmExtractor {
  extract(content: string): Promise<ExtractionResult>;
}

const DIRECTIONS: ReadonlySet<string> = new Set(['request', 'response', 'operation', 'security']);

export interface AnchorResult {
  readonly accepted: readonly ExtractedChange[];
  readonly rejected: readonly { readonly value: unknown; readonly reason: string }[];
}

// Validate shape, then anchor each quote to the source by exact substring match.
// A change whose quote is not present verbatim is discarded - this kills
// hallucinated changes at the boundary (spec section 9.1).
export function anchorAndValidate(candidates: readonly unknown[], source: string): AnchorResult {
  const accepted: ExtractedChange[] = [];
  const rejected: { value: unknown; reason: string }[] = [];
  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (!parsed.ok) {
      rejected.push({ value: candidate, reason: parsed.reason });
    } else if (!source.includes(parsed.value.quote)) {
      rejected.push({ value: candidate, reason: 'quote_not_anchored' });
    } else {
      accepted.push(parsed.value);
    }
  }
  return { accepted, rejected };
}

export interface ChangelogMapInput {
  readonly vendorId: string;
  readonly releaseId: string;
  readonly specHashFrom: string;
  readonly specHashTo: string;
  readonly extraction: ExtractionResult;
  readonly accepted: readonly ExtractedChange[];
}

// Extracted changes are always detection_method changelog_scrape (classified
// ambiguous downstream, spec section 9.2) and carry the model provenance and the
// anchored quote as evidence.
export function mapExtractedChanges(input: ChangelogMapInput): ChangeRecord[] {
  return input.accepted.map((change) => ({
    change_id: prefixedId(
      'chg',
      input.vendorId,
      change.path,
      change.change_type,
      input.specHashFrom,
      input.specHashTo,
      change.quote,
    ),
    release_id: input.releaseId,
    vendor_id: input.vendorId,
    path: change.path,
    method: null,
    direction: change.direction,
    field_path: change.field_path ?? null,
    change_type: change.change_type,
    evidence: {
      quote: change.quote,
      model: input.extraction.model,
      model_version: input.extraction.modelVersion,
      prompt_hash: input.extraction.promptHash,
    },
    spec_fragment: null,
    evidence_strength: 'changelog_confirmed',
    detection_method: 'changelog_scrape',
  }));
}

function parseCandidate(
  value: unknown,
): { ok: true; value: ExtractedChange } | { ok: false; reason: string } {
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'not_object' };
  const o = value as Record<string, unknown>;
  if (typeof o['change_type'] !== 'string') return { ok: false, reason: 'change_type' };
  const direction = o['direction'];
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) return { ok: false, reason: 'direction' };
  if (typeof o['path'] !== 'string') return { ok: false, reason: 'path' };
  const quote = o['quote'];
  if (typeof quote !== 'string' || quote.length === 0) return { ok: false, reason: 'quote' };
  if (o['field_path'] !== undefined && typeof o['field_path'] !== 'string') {
    return { ok: false, reason: 'field_path' };
  }
  return {
    ok: true,
    value: {
      change_type: o['change_type'],
      direction: direction as ChangeDirection,
      path: o['path'],
      quote,
      ...(typeof o['field_path'] === 'string' ? { field_path: o['field_path'] } : {}),
    },
  };
}
