import type { BreakKind, ChangeRecord, Classification, RequestStrictness } from '@paritydiff/core';

export const CLASSIFIER_VERSION = '2026-10-15.2';

export interface ClassifyContext {
  readonly strictUnknownRequestFields: RequestStrictness;
  readonly exhaustiveTypedSdk: boolean;
}

interface Outcome {
  readonly classification: Classification;
  readonly break_kind: BreakKind | null;
  readonly rule_id: string;
}

const brk = (kind: BreakKind, rule: string): Outcome => ({
  classification: 'breaking',
  break_kind: kind,
  rule_id: rule,
});
const nonbrk = (rule: string): Outcome => ({
  classification: 'non_breaking',
  break_kind: null,
  rule_id: rule,
});
const amb = (rule: string): Outcome => ({
  classification: 'ambiguous',
  break_kind: null,
  rule_id: rule,
});
const dep = (rule: string): Outcome => ({
  classification: 'deprecation',
  break_kind: null,
  rule_id: rule,
});

// oasdiff emits a composition keyword (all-of/one-of/any-of) in the id when a
// property lives inside an allOf/oneOf/anyOf schema - extremely common with
// inheritance. Strip that keyword so `response-property-all-of-removed` matches the
// same rule as `response-property-removed`; without this the composed variants fall
// through to the level fallback and are wrongly bucketed ambiguous.
function stripComposition(id: string): string {
  return id.replace(/-(all-of|one-of|any-of)-/g, '-');
}

export function decideChange(change: ChangeRecord, ctx: ClassifyContext): Outcome {
  if (change.detection_method === 'changelog_scrape') return amb('override.changelog_scrape');
  const id = stripComposition(change.change_type);
  if (id.includes('coverage-incomplete')) return amb('coverage.incomplete');
  if (id === 'native-http-method-changed') return brk('runtime', 'native.http_method_changed');
  if (id === 'native-http-location-removed') return brk('runtime', 'native.http_location_removed');
  if (
    /^native-asyncapi-(address-changed|direction-changed|server-removed|http-method-changed|reply-removed|reply-address-changed|reply-status-changed|wire-binding-changed|message-removed|message-content-type-changed|message-correlation-changed)$/.test(
      id,
    )
  )
    return brk('runtime', 'native.asyncapi_binding_changed');
  if (id === 'request-schema-acceptance-narrowed') {
    const comparison = change.evidence['semantic_comparison'] as
      { status?: string; beforeSubsetAfter?: boolean; reason?: string } | undefined;
    return comparison?.status === 'different' &&
      comparison.beforeSubsetAfter === false &&
      comparison.reason === 'validated_counterexample'
      ? brk('runtime', 'schema.request_acceptance_narrowed')
      : amb('schema.comparison_proof_unavailable');
  }
  if (id === 'response-schema-acceptance-expanded')
    return amb('schema.response_expansion_consumer_policy');
  if (id.includes('deprecated') || id.includes('sunset')) return dep('deprecation');
  if (id.startsWith('api-removed') || id.startsWith('api-path-removed')) {
    return brk('runtime', 'operation.endpoint_removed');
  }
  if (id === 'security-requirement-tightened') return brk('runtime', 'security.requirement_added');
  if (id === 'security-alternative-added') return nonbrk('security.alternative_added');
  if (id.includes('security-added') || id.includes('security-scope-added')) {
    return brk('runtime', 'security.requirement_added');
  }
  if (id.includes('security-removed')) return nonbrk('security.requirement_removed');
  if (change.direction === 'request') return decideRequest(id, ctx) ?? byLevel(change);
  if (change.direction === 'response') return decideResponse(id, ctx) ?? byLevel(change);
  return byLevel(change);
}

function decideRequest(id: string, ctx: ClassifyContext): Outcome | null {
  if (id.includes('media-type-removed') || id === 'request-body-removed')
    return brk('runtime', 'request.content_removed');
  if (id.startsWith('new-required-request') || id.includes('became-required')) {
    return brk('runtime', 'request.now_required');
  }
  if (id.includes('enum-value-removed')) return brk('runtime', 'request.enum_removed');
  if (id.includes('enum-value-added')) return nonbrk('request.enum_added');
  if (id.includes('became-optional')) return nonbrk('request.now_optional');
  // A required addition is already handled above (now_required); a plain added
  // request property is optional, so a client that omits it still validates.
  if (id.includes('property-added')) return nonbrk('request.added');
  if (id.includes('property-removed') || id.includes('parameter-removed')) {
    if (ctx.strictUnknownRequestFields === true) return brk('runtime', 'request.removed_strict');
    if (ctx.strictUnknownRequestFields === false) return nonbrk('request.removed_lenient');
    return amb('request.removed_unknown_strictness');
  }
  if (id.includes('type-changed')) return amb('request.type_changed');
  return null;
}

function decideResponse(id: string, ctx: ClassifyContext): Outcome | null {
  if (id === 'response-disjoint-union-added')
    return ctx.exhaustiveTypedSdk
      ? brk('typed', 'response.union_added_typed')
      : nonbrk('response.union_added');
  if (id.includes('property-removed') || id.includes('header-became-optional')) {
    return brk('runtime', 'response.removed');
  }
  if (id.includes('became-optional') || id.includes('became-nullable')) {
    return brk('runtime', 'response.now_optional_or_nullable');
  }
  if (id.includes('became-required')) return nonbrk('response.now_required');
  if (id.includes('property-added') || id.includes('enum-value-added')) {
    return ctx.exhaustiveTypedSdk ? brk('typed', 'response.added_typed') : nonbrk('response.added');
  }
  if (id.includes('enum-value-removed')) return amb('response.enum_removed');
  if (id.includes('type-changed')) return amb('response.type_changed');
  return null;
}

function byLevel(change: ChangeRecord): Outcome {
  const level = levelOf(change);
  if (level === 3) return brk('runtime', 'level.error');
  if (level === 2) return amb('level.warning');
  if (level === 1) return nonbrk('level.info');
  return amb('level.unknown');
}

export function levelOf(change: ChangeRecord): number | undefined {
  const level = change.evidence['level'];
  return typeof level === 'number' ? level : undefined;
}
