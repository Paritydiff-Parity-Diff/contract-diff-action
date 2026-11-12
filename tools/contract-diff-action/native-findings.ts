import { contentHash, type Classification } from '../../packages/core/src/index';
import { parseProtocolContract } from '../../packages/detect/src/protocol-parser';

export interface NativeFinding {
  classification: Classification;
  path: string;
  method: null;
  rule: string;
}
type Descriptor = Record<string, unknown>;
const record = (value: unknown): Descriptor =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Descriptor) : {};
const native = (value: unknown) => record(value)['x-paritydiff-native-contract'];

function descriptors(input: unknown) {
  const out = new Map<string, Descriptor>();
  function add(node: unknown, namespace: string) {
    for (const [name, value] of Object.entries(record(record(node)['nested']))) {
      const path = namespace ? namespace + '.' + name : name;
      const item = record(value);
      out.set(path, item);
      add(item, path);
    }
  }
  add(input, '');
  return out;
}

function protobufFindings(before: unknown, after: unknown): NativeFinding[] {
  const findings: NativeFinding[] = [];
  const old = descriptors(native(before));
  const next = descriptors(native(after));
  const emit = (path: string, rule: string, classification: Classification) =>
    findings.push({ path, rule: 'protobuf.' + rule, classification, method: null });
  for (const [name, previous] of old) {
    const current = next.get(name);
    if (!current) continue;
    const oldFields = record(previous['fields']);
    const newFields = record(current['fields']);
    const fieldsByNumber = new Map(
      Object.entries(newFields).map(([field, value]) => [record(value)['id'], field]),
    );
    const oneof = (message: Descriptor, field: string) =>
      Object.entries(record(message['oneofs']))
        .filter(
          ([, item]) =>
            Array.isArray(record(item)['oneof']) &&
            (record(item)['oneof'] as unknown[]).includes(field),
        )
        .map(([group]) => group)
        .sort();
    for (const [field, value] of Object.entries(oldFields)) {
      const a = record(value);
      const b = record(newFields[field]);
      const path = name + '.' + field;
      if (Object.hasOwn(newFields, field) && a['id'] !== b['id']) {
        emit(path, 'field_number_changed', 'breaking');
        continue;
      }
      const replacement = fieldsByNumber.get(a['id']);
      if (replacement && replacement !== field) {
        const newField = record(newFields[replacement]);
        emit(
          path,
          'field_number_reused',
          newField['type'] === a['type'] ? 'ambiguous' : 'breaking',
        );
      }
      if (!Object.hasOwn(newFields, field)) continue;
      if (a['type'] !== b['type'] || a['keyType'] !== b['keyType'] || a['rule'] !== b['rule'])
        emit(path, 'field_encoding_review', 'ambiguous');
      if (contentHash(oneof(previous, field)) !== contentHash(oneof(current, field)))
        emit(path, 'oneof_membership_changed', 'ambiguous');
      if (record(a['options'])['default'] !== record(b['options'])['default'])
        emit(path, 'field_default_changed', 'ambiguous');
    }
    for (const [method, raw] of Object.entries(record(previous['methods']))) {
      const newMethods = record(current['methods']);
      if (!Object.hasOwn(newMethods, method)) continue;
      const a = record(raw);
      const b = record(newMethods[method]);
      const path = '/grpc/' + name + '/' + method;
      if (
        Boolean(a['requestStream']) !== Boolean(b['requestStream']) ||
        Boolean(a['responseStream']) !== Boolean(b['responseStream'])
      )
        emit(path, 'rpc_streaming_changed', 'breaking');
      if (a['requestType'] !== b['requestType'] || a['responseType'] !== b['responseType'])
        emit(path, 'rpc_message_type_changed', 'ambiguous');
    }
  }
  return findings;
}

function soapFindings(before: unknown, after: unknown): NativeFinding[] {
  const findings: NativeFinding[] = [];
  const bindings = (value: unknown) => {
    const list = record(value)['x-paritydiff-soap-bindings'];
    return Array.isArray(list) ? list.map(record) : [];
  };
  const key = (binding: Descriptor) =>
    contentHash(binding['bindingId'], binding['path'], binding['direction']);
  const next = new Map(bindings(after).map((binding) => [key(binding), binding]));
  for (const a of bindings(before)) {
    const path = a['path'];
    if (typeof path !== 'string') continue;
    const b = next.get(key(a));
    if (!b) continue;
    const emit = (rule: string, classification: Classification) =>
      findings.push({ path, rule: 'soap.' + rule, classification, method: null });
    for (const [field, rule] of [
      ['action', 'action_changed'],
      ['envelope', 'envelope_changed'],
      ['transport', 'transport_changed'],
      ['wireUse', 'body_encoding_changed'],
    ] as const) {
      if (typeof a[field] === 'string' && typeof b[field] === 'string' && a[field] !== b[field])
        emit(rule, 'breaking');
    }
    for (const field of [
      'elements',
      'headerElements',
      'encodingStyle',
      'requiredExtensions',
      'multipart',
    ])
      if (contentHash(a[field] ?? null) !== contentHash(b[field] ?? null))
        emit('serialization_binding_changed', 'ambiguous');
    if (a['supported'] === true && b['supported'] !== true)
      emit('binding_coverage_lost', 'ambiguous');
  }
  const schemas = (value: unknown) =>
    record(record(value)['x-paritydiff-xml-schema-bundle'])['files'] ?? {};
  if (contentHash(schemas(before)) !== contentHash(schemas(after)))
    findings.push({
      path: 'WSDL schema declarations',
      rule: 'soap.xsd_payload_compatibility_requires_validation',
      classification: 'ambiguous',
      method: null,
    });
  return findings;
}

export async function nativeFindings(
  standard: string,
  contractPath: string,
  before: unknown,
  after: unknown,
  operationPaths?: readonly string[],
  readBase?: (path: string) => Promise<string | null>,
) {
  if (standard === 'grpc') return protobufFindings(before, after);
  if (standard === 'soap') return soapFindings(before, after);
  if (standard !== 'graphql') return [];
  const operations = [];
  for (const path of operationPaths ?? []) {
    const source = await readBase?.(path);
    operations.push({
      path,
      source: source && Buffer.byteLength(source) <= 128 * 1024 ? source : null,
    });
  }
  const result = await parseProtocolContract({
    'x-paritydiff-graphql-compatibility': true,
    before: native(before),
    after: native(after),
    operations,
  });
  return (
    result.document['changes'] as (Pick<NativeFinding, 'rule' | 'classification'> & {
      path?: string;
    })[]
  ).map((change) => ({
    ...change,
    rule: 'graphql.' + change.rule,
    path: change.path ?? contractPath,
    method: null,
  }));
}
