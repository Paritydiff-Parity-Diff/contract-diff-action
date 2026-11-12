export function knownSchemaDialect(dialect: string): boolean;
export function metaschemaCatalog(documents: ReadonlyMap<string, unknown>): unknown;
export function prepareCapturedContract(
  input: unknown,
  resources: readonly unknown[],
): {
  document: unknown;
  profiles: readonly unknown[];
};
export function prepareCapturedSchema(
  schema: unknown,
  resources: readonly unknown[],
  dialect?: string,
  options?: { formatAssertions?: boolean | 'dialect' },
): {
  schema: unknown;
  resources: unknown[];
  dialect: string;
  changed: boolean;
  profiles: readonly unknown[];
};
