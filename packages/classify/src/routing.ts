import type { ChangeRecord, ClassificationRecord, ReviewRoute } from '@paritydiff/core';

// Route a review item by who holds the knowledge (decision D-4). Returns null
// when the classification is confident and needs no human. Order matters: the
// more specific vendor routes are checked before the generic operator catch-all.
export function routeReview(
  change: ChangeRecord,
  classification: ClassificationRecord,
): ReviewRoute | null {
  const cls = classification.classification;

  if (change.detection_method === 'changelog_scrape') {
    return route('operator', 'extraction_quality', 'internal', false);
  }
  if (classification.rule_id === 'request.removed_unknown_strictness') {
    return route('vendor', 'request_strictness_unknown', 'vendor_scrubbed', true);
  }
  if (
    cls === 'deprecation' &&
    (change.change_type.includes('sunset-missing') || change.change_type.includes('sunset-parse'))
  ) {
    return route('vendor', 'deprecation_no_sunset', 'vendor_scrubbed', false);
  }
  if (cls === 'ambiguous') {
    return route('operator', 'ambiguous_unrouted', 'internal', false);
  }
  return null;
}

function route(
  assigned_role: ReviewRoute['assigned_role'],
  route_reason: string,
  visibility: ReviewRoute['visibility'],
  generalizes_to_config: boolean,
): ReviewRoute {
  return { assigned_role, route_reason, visibility, generalizes_to_config };
}
