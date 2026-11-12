import {
  prefixedId,
  type ChangeDirection,
  type ChangeRecord,
  type EvidenceStrength,
  type OasdiffChange,
} from '@paritydiff/core';
import { specFragmentBuilder } from './fragment';

export function directionFromCheckId(id: string): ChangeDirection {
  if (
    id.startsWith('request-') ||
    id.startsWith('new-required-request') ||
    id.startsWith('new-optional-request')
  )
    return 'request';
  if (id.startsWith('response-')) return 'response';
  if (id.includes('security')) return 'security';
  return 'operation';
}

export interface MapChangesInput {
  readonly vendorId: string;
  readonly releaseId: string;
  readonly specHashFrom: string;
  readonly specHashTo: string;
  readonly evidenceStrength: EvidenceStrength;
  readonly changes: readonly OasdiffChange[];
  // The two normalized spec bodies, when the caller has them. Present lets us slice
  // the path-scoped diff fragment the dashboard renders as evidence; absent leaves
  // spec_fragment null and the reader falls back to the oasdiff summary line.
  readonly fromSpec?: string;
  readonly toSpec?: string;
  readonly parsedSpecs?: { readonly from: unknown; readonly to: unknown };
}

// Turn the oasdiff change feed into our change records. change_id is a content
// hash per release so re-running its diff yields the same ids (spec section 9.1
// idempotency). The oasdiff id and level are preserved as machine-checkable
// evidence; classification happens later (section 9.2, ADR 0003).
export function mapOasdiffChanges(input: MapChangesInput): ChangeRecord[] {
  const fragment =
    input.fromSpec !== undefined && input.toSpec !== undefined
      ? specFragmentBuilder(input.fromSpec, input.toSpec, input.parsedSpecs)
      : undefined;
  return input.changes.map((change) => {
    const path = change.path ?? '';
    return {
      change_id: prefixedId(
        'chg',
        input.vendorId,
        input.releaseId,
        path,
        change.id,
        input.specHashFrom,
        input.specHashTo,
        change.fingerprint ?? change.text,
      ),
      release_id: input.releaseId,
      vendor_id: input.vendorId,
      path,
      method: change.operation ?? null,
      direction: directionFromCheckId(change.id),
      field_path:
        change.fieldPath ??
        (/(property|parameter)/.test(change.id)
          ? (/(?:property|parameter) [`'"]([^`'"]+)[`'"]/.exec(change.text)?.[1] ?? null)
          : null),
      change_type: change.id,
      evidence: {
        oasdiff_id: change.id,
        level: change.level,
        text: change.text,
        fingerprint: change.fingerprint ?? null,
        ...(change.semanticComparison ? { semantic_comparison: change.semanticComparison } : {}),
      },
      spec_fragment: fragment && path ? fragment(path) : null,
      evidence_strength: input.evidenceStrength,
      detection_method: 'openapi_diff',
    };
  });
}
