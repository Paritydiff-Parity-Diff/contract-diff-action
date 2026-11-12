export const legacySchemaUris: readonly string[];
export function legacySchemaDialect(
  uri: unknown,
): { name: 'draft6' | 'draft7'; uri: string } | undefined;
export function assertLegacySchemaKeywords(input: unknown, inherited: 'draft6' | 'draft7'): void;
