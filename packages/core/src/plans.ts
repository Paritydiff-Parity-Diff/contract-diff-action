export const PLAN_LIMITS = {
  free: { repos: 2, vendors: 3, seats: 1, draftPr: false },
  starter: { repos: 2, vendors: 3, seats: 1, draftPr: false },
  pro: { repos: 10, vendors: 10, seats: 3, draftPr: true },
  advanced: { repos: 50, vendors: 30, seats: 10, draftPr: true },
  team: { repos: 50, vendors: 30, seats: 10, draftPr: true },
} as const;

export const AI_PLAN_CREDITS = {
  free: 0,
  starter: 100,
  pro: 400,
  advanced: 1500,
  team: 100,
} as const;

export const AI_REPAIR_POLICY = {
  generationAttempts: 2,
  creditsPerCallSite: 1,
  maxCreditsPerPr: 5,
  creditsPerSandboxRun: 20,
} as const;

export function repairCreditCost(callSites: number): number {
  if (!Number.isSafeInteger(callSites) || callSites < 0)
    throw new Error('invalid_validated_call_site_count');
  return Math.min(
    callSites * AI_REPAIR_POLICY.creditsPerCallSite,
    AI_REPAIR_POLICY.maxCreditsPerPr,
  );
}
