import { prefixedId, type ChangeRecord, type ClassificationRecord } from '@paritydiff/core';
import { CLASSIFIER_VERSION, decideChange, levelOf, type ClassifyContext } from './rules';
export { CLASSIFIER_VERSION, type ClassifyContext } from './rules';

export function classifyChange(change: ChangeRecord, ctx: ClassifyContext): ClassificationRecord {
  const base = decideChange(change, ctx);
  const final = base;
  return {
    classification_id: prefixedId('cls', change.change_id, CLASSIFIER_VERSION),
    change_id: change.change_id,
    classification: final.classification,
    break_kind: final.classification === 'breaking' ? final.break_kind : null,
    rule_id: final.rule_id,
    evidence: {
      oasdiff_id: change.change_type,
      oasdiff_level: levelOf(change) ?? null,
      direction: change.direction,
      evidence_strength: change.evidence_strength,
      ...(change.evidence['semantic_comparison']
        ? { semantic_comparison: change.evidence['semantic_comparison'] }
        : {}),
    },
    reasoning: `${final.rule_id}: ${change.direction} ${change.change_type} -> ${final.classification}`,
    classifier_version: CLASSIFIER_VERSION,
  };
}
