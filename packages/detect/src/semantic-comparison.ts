import { parseProtocolContract } from './protocol-parser';
export interface SemanticComparison {
  status: 'equivalent' | 'different' | 'undetermined';
  reason: string;
  beforeSubsetAfter: boolean | 'unknown';
  afterSubsetBefore: boolean | 'unknown';
  witnesses?: { beforeOnly?: unknown; afterOnly?: unknown };
  profile?: { dialect: string; formatAssertions: boolean; finiteDomainLimit: number };
}
export async function compareJsonSchemas(
  before: unknown,
  after: unknown,
  resources: readonly unknown[] = [],
  timeoutMs = 3000,
  resourceSets?: {
    before: readonly unknown[];
    after: readonly unknown[];
    beforeDialect?: string;
    afterDialect?: string;
    formatAssertions?: boolean | 'dialect';
  },
): Promise<SemanticComparison> {
  try {
    return (
      await parseProtocolContract(
        {
          'x-paritydiff-semantic-comparison': true,
          before,
          after,
          resources,
          ...(resourceSets
            ? {
                beforeResources: resourceSets.before,
                afterResources: resourceSets.after,
                ...(resourceSets.beforeDialect
                  ? { beforeDialect: resourceSets.beforeDialect }
                  : {}),
                ...(resourceSets.afterDialect ? { afterDialect: resourceSets.afterDialect } : {}),
                ...(resourceSets.formatAssertions !== undefined
                  ? { formatAssertions: resourceSets.formatAssertions }
                  : {}),
              }
            : {}),
        },
        timeoutMs,
      )
    ).document['comparison'] as unknown as SemanticComparison;
  } catch {
    return {
      status: 'undetermined',
      reason: 'comparison_deadline_or_resource_unavailable',
      beforeSubsetAfter: 'unknown',
      afterSubsetBefore: 'unknown',
    };
  }
}
