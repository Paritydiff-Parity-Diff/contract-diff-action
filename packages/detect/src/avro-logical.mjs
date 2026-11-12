import avro from 'avsc';
const invalid = () =>
  Object.assign(new Error('asyncapi_avro_logical_value_invalid'), { available: true });
const unavailable = () =>
  Object.assign(new Error('asyncapi_avro_logical_value_budget'), { available: false });
export const AVRO_IMPLEMENTATION = 'avsc@5.7.9+paritydiff-logical-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class NativeLogicalType extends avro.types.LogicalType {
  constructor(schema, options) {
    super(schema, options);
    this.kind = schema.logicalType;
    const type = this.underlyingType.typeName;
    if (this.kind === 'uuid' && type === 'string') return;
    if (this.kind === 'time-millis' && type === 'int') return;
    if (this.kind === 'time-micros' && type === 'long') return;
    if (this.kind === 'decimal' && ['bytes', 'fixed'].includes(type)) {
      const precision = schema.precision,
        scale = schema.scale ?? 0;
      if (
        !Number.isSafeInteger(precision) ||
        precision < 1 ||
        !Number.isSafeInteger(scale) ||
        scale < 0 ||
        scale > precision
      )
        throw Error('invalid_avro_logical_schema');
      if (type === 'fixed') {
        const size = this.underlyingType.getSize();
        if (!Number.isSafeInteger(size) || size < 1) throw Error('invalid_avro_logical_schema');
        const bits = 8n * BigInt(size) - 1n;
        const lower = (bits * 301029995663981n) / 1000000000000000n,
          upper = (bits * 301029995663982n) / 1000000000000000n;
        if (lower !== upper) throw Error('avro_decimal_precision_bound_unavailable');
        if (BigInt(precision) > lower) throw Error('invalid_avro_logical_schema');
      }
      this.precision = precision;
      return;
    }
    throw Error('invalid_avro_logical_schema');
  }
  check(value) {
    if (this.kind === 'uuid') {
      if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
    } else if (this.kind === 'time-millis' || this.kind === 'time-micros') {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value >= (this.kind === 'time-millis' ? 86400000 : 86400000000)
      )
        throw invalid();
    } else {
      if (!Buffer.isBuffer(value) || !value.length) throw invalid();
      if (value.length > 65536) throw unavailable();
      let integer = BigInt('0x' + value.toString('hex'));
      if (value[0] & 128) integer -= 1n << (8n * BigInt(value.length));
      if (integer < 0n) integer = -integer;
      if (integer.toString().length > this.precision) throw invalid();
    }
    return value;
  }
  _fromValue(value) {
    return this.check(value);
  }
  _toValue(value) {
    return this.check(value);
  }
}
export const logicalTypes = Object.assign(
  Object.create(null),
  Object.fromEntries(
    ['uuid', 'decimal', 'time-millis', 'time-micros'].map((name) => [name, NativeLogicalType]),
  ),
);
export function assertAvroLogicalBudget(schema) {
  if (schema?.type !== 'fixed' || !Number.isSafeInteger(schema.size) || schema.size < 1) return;
  if (schema.size > 1024 * 1024) throw unavailable();
  if (schema.logicalType === 'decimal') {
    const bits = 8n * BigInt(schema.size) - 1n;
    if (
      (bits * 301029995663981n) / 1000000000000000n !==
      (bits * 301029995663982n) / 1000000000000000n
    )
      throw unavailable();
  }
}
