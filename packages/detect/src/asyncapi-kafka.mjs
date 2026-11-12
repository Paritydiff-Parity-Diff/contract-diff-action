import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
import { compiler } from './semantic-compare.mjs';
import {
  decodeKafkaProduce,
  decodeKafkaProduceResponse,
  decodeKafkaFetchExchange,
} from './kafka-wire.mjs';
import { avroBinaryContentType } from './asyncapi-avro.mjs';
import { protobufContentType } from './asyncapi-protobuf.mjs';
import { validateKafkaTransaction } from './kafka-transaction.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
const bytes = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw unavailable('asyncapi_kafka_wire_unavailable');
  return Buffer.from(value, 'base64');
};
function recordInput(input, request, record, channel) {
  const wire = input.transport.kafka;
  if (record.value === null) throw unavailable('asyncapi_kafka_tombstone_unavailable');
  let payload;
  if (!avroBinaryContentType(wire.contentType) && !protobufContentType(wire.contentType)) {
    try {
      payload = parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(record.value));
    } catch (error) {
      throw error.message.endsWith('_unavailable')
        ? unavailable(error.message)
        : invalid('asyncapi_kafka_payload_invalid');
    }
  }
  const binary = (value) =>
    value === null
      ? null
      : wire.binaryEncoding === 'base64'
        ? value.toString('base64')
        : wire.binaryEncoding === 'utf8'
          ? new TextDecoder('utf8', { fatal: true }).decode(value)
          : (() => {
              throw unavailable('asyncapi_kafka_binary_representation_unavailable');
            })();
  const fields = new Map();
  for (const [name, value] of record.headers) {
    const decoded = binary(value);
    if (!fields.has(name)) fields.set(name, decoded);
    else {
      const prior = fields.get(name);
      fields.set(name, Array.isArray(prior) ? [...prior, decoded] : [prior, decoded]);
    }
  }
  return {
    ...input,
    payload,
    payloadBytesBase64: record.value.toString('base64'),
    transport: {
      ...input.transport,
      channel,
      contentType: wire.contentType,
      headers: Object.fromEntries(fields),
      kafka: { ...wire, request, record, key: binary(record.key) },
    },
  };
}
async function replyProof(input, validate, requests) {
  const models = input.native.document['x-paritydiff-asyncapi-bindings'] ?? [],
    selected = models.filter(
      (model) =>
        input.native.operationPaths?.includes(model.path) &&
        model.direction === 'input' &&
        model.reply,
    );
  if (!selected.length) return {};
  if (selected.length !== 1 || !selected[0].reply.available || requests.length > 16)
    throw unavailable('asyncapi_kafka_reply_context_unavailable');
  const wire = input.transport.kafka,
    fetches = wire.fetches;
  if (!Array.isArray(fetches) || !fetches.length || fetches.length > 64)
    throw unavailable('asyncapi_kafka_reply_capture_unavailable');
  const candidates = [];
  for (const fetch of fetches) {
    if (
      !fetch ||
      typeof fetch.elapsedMs !== 'number' ||
      !Number.isFinite(fetch.elapsedMs) ||
      fetch.elapsedMs < 0 ||
      typeof fetch.connectionId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(fetch.connectionId)
    )
      throw unavailable('asyncapi_kafka_reply_exchange_unavailable');
    const request = bytes(fetch.request),
      response = bytes(fetch.response);
    if (hash(request) !== fetch.requestHash || hash(response) !== fetch.responseHash)
      throw unavailable('asyncapi_kafka_reply_hash_mismatch');
    const decoded = await decodeKafkaFetchExchange(request, response);
    for (const record of decoded.records) {
      if (candidates.length >= 256) throw unavailable('asyncapi_kafka_reply_record_limit');
      candidates.push({ ...record, fetch, decoded });
    }
  }
  const replies = [],
    headers = new Set();
  for (const request of requests) {
    if (!request.result.correlationHash)
      throw unavailable('asyncapi_kafka_reply_correlation_unavailable');
    const address = selected[0].reply.address;
    if (!request.result.replyAddressHash && (typeof address !== 'string' || /[{}]/.test(address)))
      throw unavailable('asyncapi_kafka_reply_address_unavailable');
    const matching = [];
    for (const candidate of candidates) {
      if (
        request.result.replyAddressHash
          ? hash(candidate.topic) !== request.result.replyAddressHash
          : candidate.topic !== address
      )
        continue;
      if (candidate.fetch.elapsedMs > 5000)
        throw unavailable('asyncapi_kafka_reply_deadline_exceeded');
      const original = request.input,
        reply = recordInput(input, candidate.decoded, candidate.record, candidate.topic);
      const result = await validate({
        ...reply,
        direction: 'output',
        requestPayload: original.payload,
        requestPayloadBytesBase64: original.payloadBytesBase64,
        requestTransport: original.transport,
      });
      if (!result.available) return result;
      if (!result.valid) {
        if (result.reason === 'asyncapi_reply_correlation_mismatch') continue;
        return result;
      }
      for (const [name] of candidate.record.headers) headers.add(name);
      matching.push({
        result,
        topic: candidate.topic,
        partition: candidate.partition,
        offset: candidate.offset,
        payloadHash: hash(candidate.record.value),
        fetchHash: candidate.fetch.responseHash,
      });
    }
    if (matching.length !== 1) throw unavailable('asyncapi_kafka_reply_exchange_unavailable');
    replies.push(matching[0]);
  }
  if (
    new Set(replies.map((reply) => JSON.stringify([reply.topic, reply.partition, reply.offset])))
      .size !== replies.length
  )
    throw unavailable('asyncapi_kafka_reply_identity_reused');
  return {
    responseSchemaValid: true,
    responseHash: hash(JSON.stringify(replies.map(({ result: _result, ...identity }) => identity))),
    responseHeaderNames: [...headers],
    responseRecordCount: replies.length,
    responseMessageId: replies.every(
      (reply) => reply.result.messageId === replies[0].result.messageId,
    )
      ? replies[0].result.messageId
      : undefined,
    responseCorrelationHash: replies.length === 1 ? replies[0].result.correlationHash : undefined,
  };
}
export async function validateKafkaPayload(input, validate) {
  try {
    const wire = input.transport.kafka,
      raw = bytes(wire?.frame),
      request = await decodeKafkaProduce(raw, {
        allowTransactions: wire.transactionEvents !== undefined,
      });
    const transaction =
      request.transactionalId === null ? undefined : await validateKafkaTransaction(wire);
    if (request.acks === 0 || wire.response === undefined)
      throw unavailable('asyncapi_kafka_delivery_incomplete');
    const response = decodeKafkaProduceResponse(bytes(wire.response), request.version);
    if (response.correlationId !== request.correlationId)
      throw invalid('asyncapi_kafka_correlation_mismatch');
    const expected = request.topics.flatMap((topic) =>
      topic.partitions.map((partition) => [topic.topic, partition.partition]),
    );
    const actual = response.topics.flatMap((topic) =>
      topic.partitions.map((partition) => [topic.topic, partition.partition]),
    );
    if (JSON.stringify(expected.sort()) !== JSON.stringify(actual.sort()))
      throw invalid('asyncapi_kafka_partition_response_mismatch');
    if (
      response.topics.some((topic) =>
        topic.partitions.some(
          (partition) => partition.errorCode !== 0 || BigInt(partition.baseOffset) < 0n,
        ),
      )
    )
      throw invalid('asyncapi_kafka_delivery_rejected');
    const results = [],
      requests = [],
      headers = new Set();
    for (const topic of request.topics) {
      if (topic.topic !== input.transport.channel)
        throw unavailable('asyncapi_kafka_mixed_topic_unavailable');
      for (const partition of topic.partitions)
        for (const batch of partition.batches)
          for (const record of batch.records) {
            if (record.value === null) throw unavailable('asyncapi_kafka_tombstone_unavailable');
            let payload;
            try {
              if (
                !avroBinaryContentType(wire.contentType) &&
                !protobufContentType(wire.contentType)
              )
                payload = parseLosslessJson(
                  new TextDecoder('utf8', { fatal: true }).decode(record.value),
                );
            } catch (error) {
              throw error.message.endsWith('_unavailable')
                ? unavailable(error.message)
                : invalid('asyncapi_kafka_payload_invalid');
            }
            const fields = new Map(),
              binary = (value) =>
                value === null
                  ? null
                  : wire.binaryEncoding === 'base64'
                    ? value.toString('base64')
                    : wire.binaryEncoding === 'utf8'
                      ? new TextDecoder('utf8', { fatal: true }).decode(value)
                      : (() => {
                          throw unavailable('asyncapi_kafka_binary_representation_unavailable');
                        })();
            for (const [name, value] of record.headers) {
              headers.add(name);
              const decoded = binary(value);
              if (fields.has(name)) {
                const prior = fields.get(name);
                fields.set(name, Array.isArray(prior) ? [...prior, decoded] : [prior, decoded]);
              } else fields.set(name, decoded);
            }
            const selectedInput = {
              ...input,
              payload,
              payloadBytesBase64: record.value.toString('base64'),
              transport: {
                ...input.transport,
                contentType: wire.contentType,
                headers: Object.fromEntries(fields),
                kafka: {
                  ...wire,
                  request,
                  record,
                  key: record.key === null ? null : binary(record.key),
                },
              },
            };
            const result = await validate(selectedInput);
            if (!result.available || !result.valid) return result;
            results.push(result);
            requests.push({ input: selectedInput, result });
          }
    }
    const reply = await replyProof(input, validate, requests);
    if (reply.available === false || reply.valid === false) return reply;
    return {
      available: true,
      valid: true,
      protocol: 'asyncapi',
      wirePayloadHash: hash(raw),
      wirePacketHash: hash(raw),
      wireHeaderNames: [...headers],
      kafkaRecords: results.length,
      ...reply,
      ...(results.length === 1 && results[0].correlationHash
        ? { correlationHash: results[0].correlationHash }
        : {}),
      ...(results.every(
        (result) => result.nativeSchemaResourceHash === results[0].nativeSchemaResourceHash,
      ) && results[0].nativeSchemaResourceHash
        ? { nativeSchemaResourceHash: results[0].nativeSchemaResourceHash }
        : {}),
      ...(results.every(
        (result) => result.nativeSchemaImplementation === results[0].nativeSchemaImplementation,
      ) && results[0].nativeSchemaImplementation
        ? { nativeSchemaImplementation: results[0].nativeSchemaImplementation }
        : {}),
      ...(results.every((result) => result.nativeSchemaFormat === results[0].nativeSchemaFormat) &&
      results[0].nativeSchemaFormat
        ? { nativeSchemaFormat: results[0].nativeSchemaFormat }
        : {}),
      kafkaAcks: request.acks,
      kafkaDelivery: transaction
        ? 'transaction_committed'
        : request.acks === -1
          ? 'in_sync_replicas'
          : 'leader_acknowledged',
      ...(transaction ? { wireTransactionHash: transaction.hash } : {}),
      messageId: results.every((result) => result.messageId === results[0].messageId)
        ? results[0].messageId
        : undefined,
    };
  } catch (error) {
    return {
      available: error.available === true,
      valid: false,
      protocol: 'asyncapi',
      reason: String(error.message).slice(0, 100),
    };
  }
}
export function validateKafkaBindings(model, message, servers, transport) {
  const channel = model.channelBindings.kafka ?? {},
    op = model.bindings.kafka ?? {},
    binding = message.bindings.kafka ?? {};
  const allowed = [
    [channel, ['topic', 'bindingVersion']],
    [op, ['clientId', 'bindingVersion']],
    [binding, ['key', 'bindingVersion']],
    ...servers.map((server) => [server.bindings.kafka ?? {}, ['bindingVersion']]),
  ];
  for (const [value, names] of allowed) {
    if (Object.keys(value).some((name) => !names.includes(name)))
      throw unavailable('asyncapi_kafka_binding_unavailable');
    if (
      value.bindingVersion !== undefined &&
      !['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0'].includes(value.bindingVersion)
    )
      throw unavailable('asyncapi_kafka_binding_version_unavailable');
  }
  if (channel.topic !== undefined && channel.topic !== transport.channel)
    throw invalid('asyncapi_kafka_topic_mismatch');
  const check = (declared, context, value) => {
    if (declared === undefined) return;
    if (!context?.available) throw unavailable('asyncapi_kafka_binding_schema_unavailable');
    if (!compiler(context.schema, context.resources, context.dialect)(value))
      throw invalid('asyncapi_kafka_binding_value_invalid');
  };
  check(op.clientId, model.kafkaClientId, transport.kafka.request.clientId);
  check(binding.key, message.kafkaKey, transport.kafka.key);
}
