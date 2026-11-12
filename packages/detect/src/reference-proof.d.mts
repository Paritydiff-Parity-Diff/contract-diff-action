export function referenceEquivalent(
  before: unknown,
  after: unknown,
  options: {
    beforeResources: readonly unknown[];
    afterResources: readonly unknown[];
    beforeDialect: string;
    afterDialect: string;
    ignoreRefSiblings: boolean;
  },
  canonical: (value: unknown, role?: string) => unknown,
): boolean;
