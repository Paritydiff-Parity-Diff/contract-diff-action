import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
const require = createRequire(import.meta.url),
  root = dirname(require.resolve('kafkajs'));
const crc32c = require(join(root, 'src/protocol/recordBatch/crc32C/index.js'));
const Decoder = require(join(root, 'src/protocol/decoder.js'));
const nativeBatch = require(join(root, 'src/protocol/recordBatch/v0/decoder.js'));
const LIMIT = 1024 * 1024;
const invalid = () => new Error('kafka_wire_invalid');
const unavailable = (name) => new Error('kafka_wire_' + name + '_unavailable');
export function kafkaReader(input) {
  const bytes = Buffer.from(input);
  let offset = 0;
  const take = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length)
      throw invalid();
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const int = (size) => take(size).readIntBE(0, size);
  const long = () => take(8).readBigInt64BE().toString();
  const variable = (wide = false) => {
    let value = 0n,
      shift = 0n;
    for (let index = 0; index < (wide ? 10 : 5); index++) {
      const byte = int(1) & 255;
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (index && byte === 0) throw invalid();
        const decoded = (value >> 1n) ^ -(value & 1n);
        if (
          decoded > BigInt(Number.MAX_SAFE_INTEGER) ||
          decoded < BigInt(Number.MIN_SAFE_INTEGER) ||
          (!wide && (decoded > 2147483647n || decoded < -2147483648n))
        )
          throw unavailable('integer');
        return Number(decoded);
      }
      shift += 7n;
    }
    throw invalid();
  };
  const text = (value) => new TextDecoder('utf8', { fatal: true }).decode(value);
  const string = (nullable = false) => {
    const size = int(2);
    if (size === -1 && nullable) return null;
    const value = text(take(size));
    if (value.includes('\0')) throw invalid();
    return value;
  };
  const binary = (varint = false) => {
    const size = varint ? variable() : int(4);
    return size === -1 ? null : take(size);
  };
  const count = (maximum = 256) => {
    const size = int(4);
    if (size < 0 || size > maximum) throw invalid();
    return size;
  };
  return {
    take,
    int,
    long,
    variable,
    text,
    string,
    binary,
    count,
    done: () => {
      if (offset !== bytes.length) throw invalid();
    },
    remaining: () => bytes.length - offset,
  };
}
async function batchRecords(bytes, sparse = false, transactional = false) {
  if (bytes.length < 61 || bytes[16] !== 2 || bytes.readInt32BE(8) + 12 !== bytes.length)
    throw invalid();
  if (crc32c(bytes.subarray(21)) !== bytes.readUInt32BE(17))
    throw new Error('kafka_wire_crc_invalid');
  const r = kafkaReader(bytes);
  const firstOffset = r.long();
  r.int(4);
  r.int(4);
  r.int(1);
  r.int(4);
  const attributes = r.int(2),
    lastDelta = r.int(4),
    firstTimestamp = r.long(),
    maxTimestamp = r.long(),
    producerId = r.long(),
    producerEpoch = r.int(2),
    firstSequence = r.int(4),
    count = r.count();
  if (attributes & ~(transactional ? 31 : 15)) throw unavailable('transaction_or_attributes');
  if (
    transactional &&
    (!(attributes & 16) || BigInt(producerId) < 0n || producerEpoch < 0 || firstSequence < 0)
  )
    throw invalid();
  const codec = attributes & 7;
  if (![0, 1].includes(codec)) throw unavailable('compression');
  const raw = r.take(r.remaining());
  const records = kafkaReader(codec === 1 ? gunzipSync(raw, { maxOutputLength: LIMIT }) : raw),
    output = [];
  for (let index = 0; index < count; index++) {
    const record = kafkaReader(records.take(records.variable())),
      flags = record.int(1),
      timestampDelta = record.variable(true),
      offsetDelta = record.variable();
    if (
      flags !== 0 ||
      offsetDelta < 0 ||
      (sparse
        ? index > 0 && offsetDelta <= output[index - 1].offsetDelta
        : offsetDelta !== index) ||
      timestampDelta < 0
    )
      throw invalid();
    const key = record.binary(true),
      value = record.binary(true),
      headersCount = record.variable(),
      headers = [];
    if (headersCount < 0 || headersCount > 128) throw invalid();
    for (let header = 0; header < headersCount; header++)
      headers.push([record.text(record.take(record.variable())), record.binary(true)]);
    record.done();
    output.push({ key, value, headers, offsetDelta, timestampDelta });
  }
  records.done();
  if (count === 0 || lastDelta !== (sparse ? output.at(-1).offsetDelta : count - 1))
    throw invalid();
  const native = await nativeBatch(new Decoder(bytes));
  if (
    native.records.length !== count ||
    native.records.some(
      (record, index) =>
        !(record.value === null
          ? output[index].value === null
          : record.value.equals(output[index].value)) ||
        !(record.key === null ? output[index].key === null : record.key.equals(output[index].key)),
    )
  )
    throw invalid();
  return {
    records: output,
    codec,
    firstOffset,
    firstTimestamp,
    maxTimestamp,
    producerId,
    producerEpoch,
    firstSequence,
    transactional,
  };
}
export async function decodeKafkaProduce(input, { allowTransactions = false } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length > LIMIT || bytes.length < 14) throw invalid();
  const r = kafkaReader(bytes);
  if (r.int(4) !== bytes.length - 4 || r.int(2) !== 0) throw invalid();
  const version = r.int(2);
  if (version < 3 || version > 7) throw unavailable('produce_version');
  const correlationId = r.int(4),
    clientId = r.string(true),
    transactionalId = r.string(true),
    acks = r.int(2),
    timeout = r.int(4);
  if (transactionalId !== null && (!allowTransactions || !transactionalId))
    throw unavailable('transaction');
  if (![-1, 0, 1].includes(acks) || timeout < 0) throw invalid();
  const topics = [],
    names = new Set();
  let messages = 0;
  const count = r.count(64);
  for (let index = 0; index < count; index++) {
    const topic = r.string();
    if (names.has(topic)) throw invalid();
    names.add(topic);
    const partitions = [],
      ids = new Set(),
      partitionCount = r.count(64);
    for (let part = 0; part < partitionCount; part++) {
      const partition = r.int(4),
        body = r.binary();
      if (partition < 0 || ids.has(partition) || !body) throw invalid();
      ids.add(partition);
      const batches = [],
        sets = kafkaReader(body);
      while (sets.remaining()) {
        const start = sets.take(12),
          length = start.readInt32BE(8);
        if (length < 49) throw invalid();
        const batch = await batchRecords(
          Buffer.concat([start, sets.take(length)]),
          false,
          transactionalId !== null,
        );
        messages += batch.records.length;
        if (messages > 256) throw new Error('kafka_wire_record_limit');
        batches.push(batch);
      }
      partitions.push({ partition, batches });
    }
    topics.push({ topic, partitions });
  }
  r.done();
  if (!messages) throw invalid();
  return { version, correlationId, clientId, transactionalId, acks, timeout, topics };
}
export function decodeKafkaProduceResponse(input, version) {
  const bytes = Buffer.from(input);
  if (bytes.length > LIMIT) throw invalid();
  const r = kafkaReader(bytes);
  if (r.int(4) !== bytes.length - 4 || version < 3 || version > 7) throw invalid();
  const correlationId = r.int(4),
    topics = [],
    count = r.count(64),
    names = new Set();
  for (let index = 0; index < count; index++) {
    const topic = r.string(),
      partitions = [],
      size = r.count(64),
      ids = new Set();
    if (names.has(topic)) throw invalid();
    names.add(topic);
    for (let part = 0; part < size; part++) {
      const partition = r.int(4),
        errorCode = r.int(2),
        baseOffset = r.long(),
        logAppendTime = r.long(),
        logStartOffset = version >= 5 ? r.long() : undefined;
      if (ids.has(partition)) throw invalid();
      ids.add(partition);
      partitions.push({ partition, errorCode, baseOffset, logAppendTime, logStartOffset });
    }
    topics.push({ topic, partitions });
  }
  const throttle = r.int(4);
  if (throttle < 0) throw invalid();
  r.done();
  return { correlationId, topics };
}
export async function decodeKafkaFetchExchange(requestBytes, responseBytes) {
  const request = Buffer.from(requestBytes),
    response = Buffer.from(responseBytes);
  if (
    request.length > LIMIT ||
    response.length > LIMIT ||
    request.length < 14 ||
    response.length < 12
  )
    throw invalid();
  const r = kafkaReader(request);
  if (r.int(4) !== request.length - 4 || r.int(2) !== 1) throw invalid();
  const version = r.int(2);
  if (version < 4 || version > 11) throw unavailable('fetch_version');
  const correlationId = r.int(4),
    clientId = r.string(true),
    replicaId = r.int(4),
    maxWait = r.int(4),
    minBytes = r.int(4),
    maxBytes = r.int(4),
    isolation = r.int(1);
  if (
    replicaId !== -1 ||
    maxWait < 0 ||
    minBytes < 0 ||
    maxBytes < 1 ||
    ![0, 1].includes(isolation)
  )
    throw invalid();
  if (version >= 7 && (r.int(4) !== 0 || r.int(4) !== -1)) throw unavailable('fetch_session');
  const requested = new Map(),
    topicNames = new Set(),
    count = r.count(64);
  for (let index = 0; index < count; index++) {
    const topic = r.string(),
      partitions = r.count(64);
    if (topicNames.has(topic)) throw invalid();
    topicNames.add(topic);
    for (let part = 0; part < partitions; part++) {
      const partition = r.int(4);
      if (version >= 9) r.int(4);
      const offset = r.long();
      if (version >= 5) r.long();
      const maximum = r.int(4),
        key = JSON.stringify([topic, partition]);
      if (partition < 0 || BigInt(offset) < 0n || maximum < 1 || requested.has(key))
        throw invalid();
      requested.set(key, { topic, partition, offset });
    }
  }
  if (version >= 7 && r.count(64)) throw unavailable('fetch_session');
  if (version >= 11) r.string();
  r.done();
  const s = kafkaReader(response);
  if (s.int(4) !== response.length - 4 || s.int(4) !== correlationId || s.int(4) < 0)
    throw invalid();
  if (version >= 7 && (s.int(2) !== 0 || s.int(4) !== 0)) throw unavailable('fetch_session');
  const seen = new Set(),
    records = [],
    responses = s.count(64);
  let recordCount = 0;
  for (let index = 0; index < responses; index++) {
    const topic = s.string(),
      partitions = s.count(64);
    for (let part = 0; part < partitions; part++) {
      const partition = s.int(4),
        errorCode = s.int(2),
        highWatermark = s.long(),
        stable = s.long();
      if (version >= 5) s.long();
      const aborted = s.int(4);
      if (aborted < -1 || aborted > 0) throw unavailable('fetch_transactions');
      if (version >= 11) s.int(4);
      const body = s.binary(),
        key = JSON.stringify([topic, partition]),
        selected = requested.get(key);
      if (
        !selected ||
        seen.has(key) ||
        errorCode ||
        BigInt(highWatermark) < 0n ||
        BigInt(stable) < -1n
      )
        throw invalid();
      seen.add(key);
      if (body === null) continue;
      const sets = kafkaReader(body);
      while (sets.remaining()) {
        if (sets.remaining() < 12) throw unavailable('fetch_partial_batch');
        const start = sets.take(12),
          length = start.readInt32BE(8);
        if (length < 49 || length > sets.remaining()) throw unavailable('fetch_partial_batch');
        const batch = await batchRecords(Buffer.concat([start, sets.take(length)]), true);
        for (const record of batch.records) {
          if (++recordCount > 256) throw new Error('kafka_wire_record_limit');
          const offset = BigInt(batch.firstOffset) + BigInt(record.offsetDelta);
          if (offset < BigInt(selected.offset)) continue;
          if (
            offset >= BigInt(highWatermark) ||
            (isolation === 1 && (BigInt(stable) < 0n || offset >= BigInt(stable)))
          )
            throw invalid();
          records.push({ topic, partition, offset: String(offset), record });
        }
      }
    }
  }
  s.done();
  if (seen.size !== requested.size) throw unavailable('fetch_partition_coverage');
  return { version, correlationId, clientId, isolation, records };
}
export function kafkaFrameStream(onFrame) {
  let pending = Buffer.alloc(0),
    count = 0;
  return {
    push(input) {
      if (!(input instanceof Uint8Array) || input.length > LIMIT) throw invalid();
      pending = Buffer.concat([pending, input]);
      while (pending.length >= 4) {
        const size = pending.readInt32BE() + 4;
        if (size < 8 || size > LIMIT) throw invalid();
        if (pending.length < size) break;
        if (++count > 4096) throw new Error('kafka_wire_frame_count_limit');
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        onFrame(frame);
      }
    },
    finish() {
      if (pending.length) throw invalid();
    },
  };
}
