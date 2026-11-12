export interface CompilerOptions {
  formatAssertions?: boolean | 'dialect';
}
export function compiler(
  schema: unknown,
  resources?: readonly unknown[],
  declaredDialect?: string,
  options?: CompilerOptions,
): (value: unknown) => boolean;
export const nativeCompiler: typeof compiler;
export const resourceCompiler: typeof compiler;
export function validateCompoundSchemaResources(
  schema: unknown,
  resources?: readonly unknown[],
  declaredDialect?: string,
): true;
export function compareSchemas(input: unknown): {
  status: 'equivalent' | 'different' | 'undetermined';
  beforeSubsetAfter: boolean | 'unknown';
  afterSubsetBefore: boolean | 'unknown';
  reason: string;
};
