import { err, ok, type Result } from '@paritydiff/core';
import { validateContractDocument } from './schema-validation';
import { validateOpenApiSemantics } from './semantic-validation';
import {
  adaptJsonSchema,
  adaptPostman,
  adaptSwagger,
  type AdaptedContract,
} from './format-adapters';

export type SourceFormat =
  | 'openapi'
  | 'swagger2'
  | 'postman'
  | 'json-schema'
  | 'asyncapi'
  | 'graphql'
  | 'protobuf'
  | 'wsdl'
  | 'xsd'
  | 'document';
export type FormatError = { readonly kind: 'unsupported_format'; readonly detected: string };

export function normalizeToOas3(
  doc: unknown,
): Result<{ readonly document: unknown; readonly sourceFormat: SourceFormat }, FormatError> {
  if (typeof doc === 'boolean') {
    const adapted = adaptJsonSchema(doc);
    return ok({ document: adapted.document, sourceFormat: adapted.sourceFormat });
  }
  if (doc !== null && typeof doc === 'object') {
    const record = doc as Record<string, unknown>;
    if (typeof record['openapi'] === 'string' && /^3\.(0|1|2)\.\d+$/.test(record['openapi'])) {
      const validation = validateContractDocument(doc);
      if (!validation.valid)
        return err({
          kind: 'unsupported_format',
          detected: 'invalid OpenAPI: ' + validation.errors.join('; '),
        });
      const semantics = validateOpenApiSemantics(doc);
      if (semantics.length)
        return err({
          kind: 'unsupported_format',
          detected: 'invalid OpenAPI: ' + semantics.join('; '),
        });
      return ok({ document: doc, sourceFormat: 'openapi' });
    }
    const adapter =
      record['swagger'] === '2.0'
        ? adaptSwagger
        : record['info'] !== undefined && Array.isArray(record['item'])
          ? adaptPostman
          : typeof record['$schema'] === 'string' ||
              ['type', 'properties', '$defs', 'allOf', 'anyOf', 'oneOf'].some((key) =>
                Object.hasOwn(record, key),
              )
            ? adaptJsonSchema
            : undefined;
    if (adapter) {
      try {
        const adapted: AdaptedContract = adapter(doc);
        const checked = normalizeToOas3(adapted.document);
        return checked.ok
          ? ok({ document: checked.value.document, sourceFormat: adapted.sourceFormat })
          : checked;
      } catch (cause) {
        return err({
          kind: 'unsupported_format',
          detected: cause instanceof Error ? cause.message : 'contract conversion unavailable',
        });
      }
    }
    if (typeof record['swagger'] === 'string')
      return err({ kind: 'unsupported_format', detected: `swagger ${record['swagger']}` });
  }
  return err({ kind: 'unsupported_format', detected: 'unknown' });
}
