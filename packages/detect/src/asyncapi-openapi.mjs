import { createRequire } from 'node:module';
import Ajv from 'ajv-legacy';
const require = createRequire(import.meta.url),
  meta = require('./schemas/openapi-3.0.json');
const ajv = new Ajv({ schemaId: 'id', meta: false, allErrors: false, validateSchema: false });
ajv.addMetaSchema(require('ajv-legacy/lib/refs/json-schema-draft-04.json'));
ajv.addSchema(meta);
const validate = ajv.compile({
  anyOf: [
    { $ref: meta.id + '#/definitions/Schema' },
    { $ref: meta.id + '#/definitions/Reference' },
  ],
});
export function assertAsyncapiOpenapi30(schema) {
  if (!validate(schema)) throw new Error('asyncapi_openapi_schema_invalid');
}
