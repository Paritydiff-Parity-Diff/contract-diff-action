export type DeliveryMode = 'shadow' | 'report' | 'draft_pr' | 'pr';
export type PrState =
  | 'planned'
  | 'opened'
  | 'merged'
  | 'closed_unmerged'
  | 'superseded'
  | 'suppressed';
export type CiStatus = 'pending' | 'passed' | 'failed' | 'no_ci';

export const DELIVERY_ORDER: readonly DeliveryMode[] = ['shadow', 'report', 'draft_pr', 'pr'];
