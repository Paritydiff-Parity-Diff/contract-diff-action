export type ChangeDirection = 'request' | 'response' | 'operation' | 'security';
export type EvidenceStrength = 'changelog_confirmed' | 'version_bumped' | 'spec_only';
export type DetectionMethod = 'openapi_diff' | 'changelog_scrape';

// One entry from `oasdiff changelog -f json`. level: 1 INFO, 2 WARN, 3 ERR.
export interface OasdiffChange {
  readonly id: string;
  readonly text: string;
  readonly level: number;
  readonly operation?: string;
  readonly operationId?: string;
  readonly path?: string;
  readonly section?: string;
  readonly fingerprint?: string;
  readonly fieldPath?: string;
  readonly semanticComparison?: Readonly<Record<string, unknown>>;
}

export type SpecFragmentKind = 'add' | 'del' | 'ctx';

// A path-scoped slice of the spec diff: the changed add/del lines with a little
// surrounding context. Spec-only evidence for the dashboard - never customer source.
export interface SpecFragmentLine {
  readonly kind: SpecFragmentKind;
  readonly text: string;
}

export interface ChangeRecord {
  readonly change_id: string;
  readonly release_id: string;
  readonly vendor_id: string;
  readonly path: string;
  readonly method: string | null;
  readonly direction: ChangeDirection;
  readonly field_path: string | null;
  readonly change_type: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly spec_fragment: readonly SpecFragmentLine[] | null;
  readonly evidence_strength: EvidenceStrength;
  readonly detection_method: DetectionMethod;
}
