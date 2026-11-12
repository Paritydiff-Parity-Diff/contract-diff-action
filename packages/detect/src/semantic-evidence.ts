import { contentHash, type OasdiffChange } from '@paritydiff/core';
import { schemaValidationContext } from './validation-graph';
import { compareJsonSchemas } from './semantic-comparison';
import { object } from './contract-tree';
export async function supplementSemanticEvidence(
  before: unknown,
  after: unknown,
  feed: readonly OasdiffChange[],
  timeoutMs = 10000,
): Promise<OasdiffChange[]> {
  const deadline = Date.now() + timeoutMs,
    output = [...feed];
  const paths = object(object(after)?.['paths']) ?? {};
  let comparisons = 0;
  for (const [path, raw] of Object.entries(paths)) {
    const operations = object(raw) ?? {};
    for (const [method, value] of Object.entries(operations)) {
      if (!/^(get|post|put|patch|delete|head|options|trace|query)$/.test(method)) continue;
      const oldOperation = object(object(object(object(before)?.['paths'])?.[path])?.[method]);
      if (!oldOperation) continue;
      const operation = object(value);
      const slots: { direction: 'request' | 'response'; media: string; status: string }[] = [];
      for (const media of Object.keys(
        object(object(operation?.['requestBody'])?.['content']) ?? {},
      ))
        slots.push({ direction: 'request', media, status: '' });
      for (const [status, response] of Object.entries(object(operation?.['responses']) ?? {}))
        for (const media of Object.keys(object(object(response)?.['content']) ?? {}))
          slots.push({ direction: 'response', media, status });
      for (const slot of slots) {
        const a = schemaValidationContext(
          before,
          method,
          path,
          slot.direction,
          slot.media,
          slot.status,
        );
        const b = schemaValidationContext(
          after,
          method,
          path,
          slot.direction,
          slot.media,
          slot.status,
        );
        if (a.schema === undefined || b.schema === undefined || contentHash(a) === contentHash(b))
          continue;
        const comparison =
          ++comparisons <= 64 && Date.now() < deadline
            ? await compareJsonSchemas(
                a.schema,
                b.schema,
                [],
                Math.max(1, Math.min(2000, deadline - Date.now())),
                {
                  before: a.resources,
                  after: b.resources,
                  beforeDialect: a.dialect,
                  afterDialect: b.dialect,
                },
              )
            : {
                status: 'undetermined',
                reason: 'comparison_budget_exceeded',
                beforeSubsetAfter: 'unknown',
                afterSubsetBefore: 'unknown',
              };
        const evidence = {
          ...comparison,
          scope: { direction: slot.direction, media: slot.media, status: slot.status },
          beforeSchemaHash: contentHash(a),
          afterSchemaHash: contentHash(b),
        };
        for (let index = 0; index < output.length; index++) {
          const change = output[index]!;
          if (
            change.path === path &&
            change.operation?.toLowerCase() === method &&
            change.id.startsWith(slot.direction + '-')
          )
            output[index] = {
              ...change,
              semanticComparison: {
                ...(change.semanticComparison ?? {}),
                [JSON.stringify([slot.media, slot.status])]: evidence,
              },
            };
        }
        const acceptance =
          slot.direction === 'request'
            ? comparison.beforeSubsetAfter
            : comparison.afterSubsetBefore;
        if (
          acceptance === 'unknown' &&
          !output.some(
            (change) =>
              change.path === path &&
              change.operation?.toLowerCase() === method &&
              change.id.startsWith(slot.direction + '-') &&
              Object.hasOwn(
                change.semanticComparison ?? {},
                JSON.stringify([slot.media, slot.status]),
              ),
          )
        )
          output.push({
            id: slot.direction + '-coverage-incomplete',
            path,
            operation: method.toUpperCase(),
            section: slot.media + ':' + slot.status,
            level: 2,
            text: 'Schema acceptance comparison is unavailable; compatibility requires review.',
            fingerprint: contentHash(
              'schema-comparison-unavailable',
              path,
              method,
              slot.direction,
              slot.media,
              slot.status,
              evidence.beforeSchemaHash,
              evidence.afterSchemaHash,
            ),
            semanticComparison: evidence,
          });
        if (
          (comparison.beforeSubsetAfter === false && slot.direction === 'request') ||
          (comparison.afterSubsetBefore === false && slot.direction === 'response')
        ) {
          const id =
            slot.direction === 'request'
              ? 'request-schema-acceptance-narrowed'
              : 'response-schema-acceptance-expanded';
          if (
            !output.some(
              (change) =>
                change.id === id &&
                change.path === path &&
                change.operation?.toLowerCase() === method &&
                change.section === slot.media + ':' + slot.status,
            )
          )
            output.push({
              id,
              path,
              operation: method.toUpperCase(),
              section: slot.media + ':' + slot.status,
              level: slot.direction === 'request' ? 3 : 2,
              text:
                'Validated schema comparison changed the ' +
                slot.direction +
                ' accepted instance set.',
              fingerprint: contentHash(
                id,
                path,
                method,
                slot.media,
                slot.status,
                evidence.beforeSchemaHash,
                evidence.afterSchemaHash,
              ),
              semanticComparison: evidence,
            });
        }
      }
    }
  }
  return output;
}
