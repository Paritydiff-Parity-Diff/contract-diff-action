import { createHash } from 'node:crypto';
import { kafkaReader, decodeKafkaProduce, decodeKafkaProduceResponse } from './kafka-wire.mjs';
const reject = (name) => {
  throw Object.assign(new Error('kafka_transaction_' + name), { available: false });
};
export function kafkaTransactionRequest(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > 1024 * 1024 || bytes.length < 14) reject('wire_invalid');
  const reader = kafkaReader(bytes);
  if (reader.int(4) !== bytes.length - 4) reject('wire_invalid');
  const api = reader.int(2),
    version = reader.int(2),
    correlationId = reader.int(4),
    clientId = reader.string(true);
  if (api === 0)
    return { api, version, correlationId, clientId, transactionalId: reader.string(true) };
  if (![22, 24, 26].includes(api) || ![0, 1].includes(version)) reject('api_unavailable');
  const transactionalId = reader.string(api === 22);
  if (transactionalId === '') reject('identity_invalid');
  const result = { api, version, correlationId, clientId, transactionalId };
  if (api === 22) {
    result.timeout = reader.int(4);
    if (result.timeout < 1) reject('timeout_invalid');
  } else {
    result.producerId = reader.long();
    result.producerEpoch = reader.int(2);
    if (BigInt(result.producerId) < 0n || result.producerEpoch < 0) reject('producer_invalid');
    if (api === 24) {
      result.partitions = [];
      const topics = reader.count(64),
        seen = new Set();
      for (let index = 0; index < topics; index++) {
        const topic = reader.string(),
          count = reader.count(64);
        if (!topic || seen.has(topic) || !count) reject('partitions_invalid');
        seen.add(topic);
        const partitions = new Set();
        for (let part = 0; part < count; part++) {
          const partition = reader.int(4);
          if (partition < 0 || partitions.has(partition)) reject('partitions_invalid');
          partitions.add(partition);
          result.partitions.push([topic, partition]);
        }
      }
      if (!result.partitions.length) reject('partitions_invalid');
    } else {
      const committed = reader.int(1);
      if (![0, 1].includes(committed)) reject('commit_invalid');
      result.committed = committed === 1;
    }
  }
  reader.done();
  return result;
}
export function kafkaTransactionResponse(
  input,
  request,
  { allowInitializationRetry = false, allowPartitionRetry = false } = {},
) {
  const bytes = Buffer.from(input),
    reader = kafkaReader(bytes);
  if (
    bytes.length > 1024 * 1024 ||
    reader.int(4) !== bytes.length - 4 ||
    reader.int(4) !== request.correlationId ||
    reader.int(4) < 0
  )
    reject('response_invalid');
  if (request.api === 24) {
    const partitions = [],
      errors = [],
      seen = new Set(),
      count = reader.count(64);
    for (let index = 0; index < count; index++) {
      const topic = reader.string(),
        length = reader.count(64);
      if (seen.has(topic)) reject('partitions_invalid');
      seen.add(topic);
      for (let part = 0; part < length; part++) {
        const partition = reader.int(4),
          error = reader.int(2);
        if (error) {
          if (!allowPartitionRetry || error !== 51) reject('partition_rejected_' + error);
          errors.push(error);
        }
        if (partition < 0) reject('partition_rejected');
        partitions.push([topic, partition]);
      }
    }
    const ordered = (values) =>
      values.map(([topic, partition]) => JSON.stringify([topic, partition])).sort();
    if (JSON.stringify(ordered(partitions)) !== JSON.stringify(ordered(request.partitions)))
      reject('partition_coverage_invalid');
    reader.done();
    return errors.length ? { partitionRetry: true } : {};
  }
  const error = reader.int(2);
  const result =
    request.api === 22 ? { producerId: reader.long(), producerEpoch: reader.int(2) } : {};
  reader.done();
  if (error !== 0) {
    if (allowInitializationRetry && request.api === 22 && [14, 15, 16].includes(error))
      return { initializationRetry: true, errorCode: error };
    reject('broker_error_' + request.api + '_' + error);
  }
  if (request.api === 22 && (BigInt(result.producerId) < 0n || result.producerEpoch < 0))
    reject('producer_invalid');
  return result;
}
const decode = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    reject('wire_invalid');
  return Buffer.from(value, 'base64');
};
export async function validateKafkaTransaction(wire) {
  const events = wire.transactionEvents;
  if (
    !Array.isArray(events) ||
    events.length < 8 ||
    events.length > 256 ||
    Buffer.byteLength(JSON.stringify(events)) > 1024 * 1024 ||
    typeof wire.transactionConnectionId !== 'string'
  )
    reject('context_unavailable');
  const requests = new Map(),
    used = new Set(),
    producers = new Map(),
    committed = [];
  const partitionKey = (topic, partition) => JSON.stringify([topic, partition]);
  for (const event of events) {
    if (
      !event ||
      !/^[a-f0-9-]{36}$/.test(event.connectionId) ||
      !['sent', 'received'].includes(event.direction) ||
      Object.keys(event).some((key) => !['connectionId', 'direction', 'frame'].includes(key))
    )
      reject('event_invalid');
    const frame = decode(event.frame);
    if (event.direction === 'sent') {
      const request = kafkaTransactionRequest(frame),
        key = event.connectionId + ':' + request.correlationId;
      if (used.has(key)) reject('correlation_invalid');
      used.add(key);
      const context = { request, frame: event.frame, connectionId: event.connectionId };
      if (request.api === 0) {
        const produce = await decodeKafkaProduce(frame, { allowTransactions: true }),
          producer = producers.get(produce.transactionalId);
        if (!producer || producer.phase !== 'active' || produce.acks !== -1)
          reject('produce_context_invalid');
        for (const topic of produce.topics)
          for (const partition of topic.partitions) {
            const id = partitionKey(topic.topic, partition.partition);
            if (!producer.partitions.has(id)) reject('partition_not_registered');
            for (const batch of partition.batches) {
              if (
                batch.firstOffset !== '0' ||
                batch.producerId !== producer.producerId ||
                batch.producerEpoch !== producer.producerEpoch ||
                batch.firstSequence !== (producer.sequences.get(id) ?? 0)
              )
                reject('sequence_invalid');
              producer.sequences.set(id, (batch.firstSequence + batch.records.length) % 2147483648);
            }
          }
        context.produce = produce;
        context.producer = producer;
        producer.members.push(context);
        if (producer.members.length > 16) reject('member_limit');
      } else if (request.api !== 22) {
        const producer = producers.get(request.transactionalId);
        if (
          !producer ||
          producer.producerId !== request.producerId ||
          producer.producerEpoch !== request.producerEpoch ||
          producer.phase === 'ending'
        )
          reject('producer_context_invalid');
        context.producer = producer;
        if (request.api === 26) {
          if (
            producer.phase !== 'active' ||
            producer.members.some((member) => !member.response) ||
            [...requests.values()].some((value) => value.producer === producer)
          )
            reject('commit_order_invalid');
          producer.phase = 'ending';
        }
      }
      requests.set(key, context);
    } else {
      if (frame.length < 8) reject('response_invalid');
      const key = event.connectionId + ':' + frame.readInt32BE(4),
        context = requests.get(key);
      if (!context) reject('correlation_invalid');
      requests.delete(key);
      const { request, producer } = context;
      if (request.api === 0) {
        const response = decodeKafkaProduceResponse(frame, context.produce.version);
        if (
          response.correlationId !== request.correlationId ||
          response.topics.length !== context.produce.topics.length
        )
          reject('produce_response_invalid');
        for (const topic of context.produce.topics) {
          const found = response.topics.find((value) => value.topic === topic.topic);
          if (
            !found ||
            found.partitions.length !== topic.partitions.length ||
            topic.partitions.some(
              (partition) =>
                !found.partitions.some(
                  (value) =>
                    value.partition === partition.partition &&
                    value.errorCode === 0 &&
                    BigInt(value.baseOffset) >= 0n,
                ),
            )
          )
            reject('produce_rejected');
        }
        context.response = event.frame;
      } else {
        const result = kafkaTransactionResponse(frame, request, {
          allowInitializationRetry: true,
          allowPartitionRetry: true,
        });
        if (request.api === 22) {
          const previous = producers.get(request.transactionalId);
          if (result.initializationRetry) {
            if (previous && previous.phase !== 'idle') reject('initialization_retry_after_publish');
            continue;
          }
          if (
            request.transactionalId === null ||
            (previous &&
              (previous.phase !== 'idle' ||
                (previous.producerId === result.producerId &&
                  result.producerEpoch <= previous.producerEpoch))) ||
            [...producers].some(
              ([id, value]) =>
                id !== request.transactionalId && value.producerId === result.producerId,
            )
          )
            reject('initialization_invalid');
          producers.set(request.transactionalId, {
            ...result,
            phase: 'idle',
            partitions: new Set(),
            sequences: new Map(),
            members: [],
          });
        } else if (request.api === 24) {
          if (result.partitionRetry) {
            if (producer.phase !== 'idle' || producer.members.length)
              reject('partition_retry_after_publish');
            continue;
          }
          for (const [topic, partition] of request.partitions)
            producer.partitions.add(partitionKey(topic, partition));
          producer.phase = 'active';
        } else {
          if (!request.committed) reject('aborted');
          committed.push([...producer.members]);
          producer.members = [];
          producer.partitions.clear();
          producer.phase = 'idle';
        }
      }
    }
  }
  const groups = committed.filter((members) =>
    members.some(
      (member) =>
        member.frame === wire.frame && member.connectionId === wire.transactionConnectionId,
    ),
  );
  if (groups.length !== 1) reject('commit_unavailable');
  if (
    !groups[0].some(
      (member) =>
        member.frame === wire.frame &&
        member.connectionId === wire.transactionConnectionId &&
        member.response === wire.response,
    )
  )
    reject('response_identity_invalid');
  return {
    members: groups[0].map(({ frame, response, connectionId }) => ({
      frame,
      response,
      connectionId,
    })),
    hash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
  };
}
