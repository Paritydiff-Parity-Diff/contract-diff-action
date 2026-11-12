import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
export const applicationAttachment = (bytes, media, part) =>
  media.essence === 'application/json'
    ? { part, bytesBase64: bytes.toString('base64') }
    : undefined;
export function validateApplicationAttachments(checks) {
  for (const check of checks) {
    const input = check.applicationAttachment;
    if (!input) continue;
    const bytes = Buffer.from(input.bytesBase64, 'base64');
    if (bytes.length > 1024 * 1024)
      throw Object.assign(new Error('application_attachment_limit'), { available: false });
    try {
      parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    } catch (error) {
      if (
        [
          'json_number_precision_unavailable',
          'json_duplicate_property',
          'json_structure_limit',
        ].includes(error.message)
      )
        throw Object.assign(new Error('application_attachment_' + error.message), {
          available: false,
        });
      throw new Error('application_attachment_json_invalid');
    }
    check.applicationCodec = {
      part: input.part,
      format: 'application/json',
      implementation: 'paritydiff-json-wire-v1',
      payloadHash: createHash('sha256').update(bytes).digest('hex'),
    };
    delete check.applicationAttachment;
  }
}
