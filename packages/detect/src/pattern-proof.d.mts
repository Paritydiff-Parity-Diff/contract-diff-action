export function patternSubset(before: string | undefined, after: string | undefined): boolean;
export function patternIntersectionSubset(
  before: readonly string[],
  after: readonly string[],
  minimum?: number,
  maximum?: number,
): boolean;
export function patternWitness(
  before: string | undefined,
  after: string | undefined,
  minimum?: number,
  maximum?: number,
): string | undefined;
export function propertyNamePartitions(
  patterns: readonly string[],
  excluded?: readonly string[],
): { matches: boolean[]; representative: string }[] | undefined;
export function patternProofProfile(): {
  implementation: string;
  unicodeVersion: string;
  runtime: { node: string; v8: string };
  assertions: string[];
  unicodeProperties: string;
  unavailable: string[];
  limits: Record<string, number>;
};
export function patternProofCapability(pattern: string): ReturnType<typeof patternProofProfile> & {
  status: 'supported' | 'unavailable';
  reason?: string;
};
