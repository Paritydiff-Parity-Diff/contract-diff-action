import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('amqplib'));
const frames = require(join(root, 'lib/frame.js'));
export const amqpMethods = require(join(root, 'lib/defs.js'));
const LIMIT = 1024 * 1024;
const invalid = () => new Error('amqp_wire_invalid');
function reader(bytes) {
  let offset = 0,
    values = 0;
  const take = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length)
      throw invalid();
    const result = bytes.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  const uint = (size) => take(size).readUIntBE(0, size);
  const text = (size) => {
    const value = new TextDecoder('utf8', { fatal: true }).decode(take(size));
    if (value.includes('\0')) throw invalid();
    return value;
  };
  const short = () => text(uint(1));
  const table = (depth = 0, array = false) => {
    if (depth > 16) throw new Error('amqp_wire_depth_limit');
    const end = offset + 4 + bytes.subarray(offset, offset + 4).readUInt32BE();
    uint(4);
    if (end > bytes.length) throw invalid();
    const entries = [],
      names = new Set();
    while (offset < end) {
      if (++values > 4096) throw new Error('amqp_wire_value_limit');
      const name = array ? undefined : short();
      if (!array && names.has(name)) throw invalid();
      names.add(name);
      const tag = String.fromCharCode(uint(1));
      let value;
      switch (tag) {
        case 'S':
          value = text(uint(4));
          break;
        case 't': {
          const bool = uint(1);
          if (bool > 1) throw invalid();
          value = !!bool;
          break;
        }
        case 'V':
          value = null;
          break;
        case 'x':
          value = Buffer.from(take(uint(4)));
          break;
        case 'D': {
          const places = uint(1),
            digits = uint(4);
          if (digits > 0x7fffffff) throw new Error('amqp_wire_decimal_sign_unavailable');
          value = { '!': 'decimal', value: { places, digits } };
          break;
        }
        case 'T': {
          const timestamp = Number(take(8).readBigUInt64BE());
          if (!Number.isSafeInteger(timestamp)) throw new Error('amqp_wire_integer_unavailable');
          value = { '!': 'timestamp', value: timestamp };
          break;
        }
        case 'b':
          value = take(1).readInt8();
          break;
        case 'B':
          value = uint(1);
          break;
        case 's':
          value = take(2).readInt16BE();
          break;
        case 'u':
          value = uint(2);
          break;
        case 'I':
          value = take(4).readInt32BE();
          break;
        case 'i':
          value = uint(4);
          break;
        case 'l':
          value = Number(take(8).readBigInt64BE());
          if (!Number.isSafeInteger(value)) throw new Error('amqp_wire_integer_unavailable');
          break;
        case 'f':
          value = take(4).readFloatBE();
          break;
        case 'd':
          value = take(8).readDoubleBE();
          break;
        case 'F':
          value = table(depth + 1);
          break;
        case 'A':
          value = table(depth + 1, true);
          break;
        default:
          throw new Error('amqp_wire_field_codec_unavailable');
      }
      if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
      entries.push(array ? value : [name, value]);
      if (offset > end) throw invalid();
    }
    return array ? entries : Object.fromEntries(entries);
  };
  return {
    take,
    uint,
    short,
    table,
    done: () => {
      if (offset !== bytes.length) throw invalid();
    },
  };
}
function properties(bytes) {
  const r = reader(bytes),
    flags = r.uint(2),
    fields = [];
  if (flags & 3) throw invalid();
  const names = [
    'contentType',
    'contentEncoding',
    'headers',
    'deliveryMode',
    'priority',
    'correlationId',
    'replyTo',
    'expiration',
    'messageId',
    'timestamp',
    'type',
    'userId',
    'appId',
    'clusterId',
  ];
  for (let index = 0; index < names.length; index++) {
    if (!(flags & (0x8000 >> index))) continue;
    const name = names[index];
    let value;
    if (name === 'headers') value = r.table();
    else if (name === 'timestamp') {
      value = Number(r.take(8).readBigUInt64BE());
      if (!Number.isSafeInteger(value)) throw new Error('amqp_wire_integer_unavailable');
    } else if (['deliveryMode', 'priority'].includes(name)) value = r.uint(1);
    else value = r.short();
    fields.push([name, value]);
  }
  r.done();
  return Object.fromEntries(fields);
}
export function decodeAmqpFrame(input) {
  if (!(input instanceof Uint8Array) || input.length > LIMIT || input.length < 8) throw invalid();
  const bytes = Buffer.from(input),
    frame = frames.parseFrame(bytes);
  if (!frame || frame.rest.length || ![1, 2, 3, 8].includes(frame.type)) throw invalid();
  if (frame.type === 8 && (frame.channel !== 0 || frame.size !== 0)) throw invalid();
  if (frame.type !== 8 && frame.channel === 0 && frame.type !== 1) throw invalid();
  if (frame.type === 2) {
    if (
      frame.size < 14 ||
      frame.payload.readUInt16BE() !== 60 ||
      frame.payload.readUInt16BE(2) !== 0
    )
      throw invalid();
    const size = Number(frame.payload.readBigUInt64BE(4));
    if (!Number.isSafeInteger(size) || size > LIMIT) throw new Error('amqp_wire_body_limit');
    return {
      type: 2,
      channel: frame.channel,
      size,
      fields: properties(frame.payload.subarray(12)),
    };
  }
  const decoded = frames.decodeFrame(frame);
  if (frame.type === 1) {
    const canonical = amqpMethods.encodeMethod(decoded.id, decoded.channel, decoded.fields);
    if (!canonical.equals(bytes)) throw new Error('amqp_wire_method_codec_unavailable');
    if (
      ['BasicAck', 'BasicNack', 'BasicReject', 'BasicDeliver', 'BasicGetOk'].some((name) => decoded.id === amqpMethods[name]) &&
      !Number.isSafeInteger(decoded.fields.deliveryTag)
    )
      throw invalid();
  }
  return { ...decoded, type: frame.type };
}
export function amqpFrameStream(onFrame, protocolHeader = false) {
  let pending = Buffer.alloc(0),
    count = 0,
    header = protocolHeader;
  return {
    push(input) {
      if (!(input instanceof Uint8Array) || input.length > LIMIT) throw invalid();
      pending = Buffer.concat([pending, input]);
      if (header) {
        if (pending.length < 8) return;
        if (!pending.subarray(0, 8).equals(Buffer.from('AMQP\0\0\x09\x01', 'binary')))
          throw invalid();
        pending = pending.subarray(8);
        header = false;
      }
      while (pending.length >= 7) {
        const size = pending.readUInt32BE(3) + 8;
        if (size > LIMIT) throw new Error('amqp_wire_frame_limit');
        if (pending.length < size) break;
        if (++count > 4096) throw new Error('amqp_wire_frame_count_limit');
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        onFrame(decodeAmqpFrame(frame), frame);
      }
    },
    finish() {
      if (pending.length || header) throw invalid();
    },
  };
}
