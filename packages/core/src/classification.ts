export type Classification = 'breaking' | 'non_breaking' | 'ambiguous' | 'deprecation';
export type BreakKind = 'runtime' | 'typed' | 'both';

export interface ClassificationRecord {
  readonly classification_id: string;
  readonly change_id: string;
  readonly classification: Classification;
  readonly break_kind: BreakKind | null;
  readonly rule_id: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly reasoning: string;
  readonly classifier_version: string;
}

export type ReviewRole = 'operator' | 'vendor';
export type ReviewVisibility = 'internal' | 'vendor_scrubbed';

export interface ReviewRoute {
  readonly assigned_role: ReviewRole;
  readonly route_reason: string;
  readonly visibility: ReviewVisibility;
  readonly generalizes_to_config: boolean;
}
