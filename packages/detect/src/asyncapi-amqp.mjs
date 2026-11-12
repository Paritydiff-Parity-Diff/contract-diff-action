import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
import { decodeAmqpFrame, amqpMethods as m } from './amqp-wire.mjs';
import { avroBinaryContentType } from './asyncapi-avro.mjs';
import { protobufContentType } from './asyncapi-protobuf.mjs';
import { amqpTransaction } from './amqp-transaction.mjs';
import { amqpDeclaration } from './amqp-topology.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
function logicalHeaders(fields, binaryEncoding, depth = 0) {
  if (depth > 16) throw unavailable('asyncapi_amqp_header_depth_limit');
  if (Buffer.isBuffer(fields)) {
    if (binaryEncoding === 'base64') return fields.toString('base64');
    if (binaryEncoding === 'utf8') {
      try {
        return new TextDecoder('utf8', { fatal: true }).decode(fields);
      } catch {
        throw invalid('asyncapi_amqp_binary_encoding_invalid');
      }
    }
    throw unavailable('asyncapi_amqp_binary_representation_unavailable');
  }
  if (Array.isArray(fields))
    return fields.map((value) => logicalHeaders(value, binaryEncoding, depth + 1));
  if (fields && typeof fields === 'object')
    return Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [
        name,
        logicalHeaders(value, binaryEncoding, depth + 1),
      ]),
    );
  return fields;
}
const decode = (encoded) => {
  if (
    typeof encoded !== 'string' ||
    encoded.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw unavailable('asyncapi_amqp_wire_unavailable');
  try {
    return decodeAmqpFrame(Buffer.from(encoded, 'base64'));
  } catch (error) {
    throw error.message.endsWith('_unavailable')
      ? unavailable(error.message)
      : invalid('asyncapi_amqp_wire_invalid');
  }
};
export function amqpWireInput(input) {
  const wire = input.transport.amqp;
  if (!wire || !Array.isArray(wire.frames) || wire.frames.length < 2 || wire.frames.length > 256)
    throw unavailable('asyncapi_amqp_wire_unavailable');
  const frames = wire.frames.map(decode),
    publish = frames[0],
    header = frames[1];
  const incoming = input.direction === 'output';
  if (
    publish.id !== (incoming ? m.BasicDeliver : m.BasicPublish) ||
    header.type !== 2 ||
    header.channel !== publish.channel ||
    frames.slice(2).some((frame) => frame.type !== 3 || frame.channel !== publish.channel)
  )
    throw invalid('asyncapi_amqp_content_order_invalid');
  if (publish.fields.immediate) throw unavailable('asyncapi_amqp_immediate_unavailable');
  const body = Buffer.concat(frames.slice(2).map((frame) => frame.content));
  if (body.length !== header.size) throw invalid('asyncapi_amqp_content_length_invalid');
  if (input.transport.channel !== publish.fields.routingKey)
    throw invalid('asyncapi_amqp_channel_mismatch');
  let transactionHash;
  if (incoming) {
    if (wire.transactionFrames !== undefined)
      throw unavailable('asyncapi_amqp_transaction_consumer_unavailable');
    const consume = decode(wire.consume),
      consumed = decode(wire.consumed);
    if (
      consume.id !== m.BasicConsume ||
      consume.fields.nowait ||
      consumed.id !== m.BasicConsumeOk ||
      consume.channel !== publish.channel ||
      consumed.channel !== publish.channel ||
      consume.fields.queue !== input.transport.channel ||
      (consume.fields.consumerTag && consume.fields.consumerTag !== consumed.fields.consumerTag) ||
      !consumed.fields.consumerTag ||
      !Number.isSafeInteger(publish.fields.deliveryTag) ||
      publish.fields.deliveryTag < 1 ||
      consumed.fields.consumerTag !== publish.fields.consumerTag ||
      publish.fields.redelivered
    )
      throw invalid('asyncapi_amqp_consumer_mismatch');
    if (!consume.fields.noAck) {
      if (wire.acknowledgment === undefined)
        throw unavailable('asyncapi_amqp_consumer_ack_incomplete');
      const ack = decode(wire.acknowledgment);
      if (
        ack.id !== m.BasicAck ||
        ack.channel !== publish.channel ||
        !(ack.fields.multiple
          ? !ack.fields.deliveryTag || ack.fields.deliveryTag >= publish.fields.deliveryTag
          : ack.fields.deliveryTag === publish.fields.deliveryTag)
      )
        throw invalid('asyncapi_amqp_consumer_ack_rejected');
    } else if (wire.acknowledgment !== undefined)
      throw invalid('asyncapi_amqp_consumer_ack_invalid');
  } else if (wire.transactionFrames !== undefined) {
    transactionHash = amqpTransaction(wire).hash;
  } else {
    if (
      !Array.isArray(wire.setup) ||
      wire.setup.length !== 2 ||
      !Number.isSafeInteger(wire.sequence) ||
      wire.sequence < 1
    )
      throw unavailable('asyncapi_amqp_confirm_setup_unavailable');
    const select = decode(wire.setup[0]),
      selected = decode(wire.setup[1]);
    if (
      select.id !== m.ConfirmSelect ||
      select.fields.nowait ||
      selected.id !== m.ConfirmSelectOk ||
      select.channel !== publish.channel ||
      selected.channel !== publish.channel
    )
      throw invalid('asyncapi_amqp_confirm_setup_invalid');
    if (wire.acknowledgment === undefined) throw unavailable('asyncapi_amqp_delivery_incomplete');
    const ack = decode(wire.acknowledgment);
    if (ack.channel !== publish.channel || ack.id === m.BasicNack)
      throw invalid('asyncapi_amqp_delivery_rejected');
    if (
      ack.id !== m.BasicAck ||
      !(ack.fields.multiple
        ? !ack.fields.deliveryTag || ack.fields.deliveryTag >= wire.sequence
        : ack.fields.deliveryTag === wire.sequence)
    )
      throw invalid('asyncapi_amqp_acknowledgment_invalid');
  }
  const properties = header.fields;
  let decoded = body;
  if (properties.contentEncoding && properties.contentEncoding !== 'identity') {
    const codec = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[
      properties.contentEncoding
    ];
    if (!codec) throw unavailable('asyncapi_amqp_content_encoding_unavailable');
    try {
      const result = codec(body, { info: true, maxOutputLength: 1024 * 1024 });
      if (result.engine.bytesWritten !== body.length) throw new Error('trailing_bytes');
      decoded = result.buffer;
    } catch {
      throw invalid('asyncapi_amqp_content_encoding_invalid');
    }
  }
  const avro =
    avroBinaryContentType(properties.contentType) || protobufContentType(properties.contentType);
  if (!avro && !/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(properties.contentType ?? ''))
    throw unavailable('asyncapi_amqp_payload_codec_unavailable');
  let payload;
  try {
    if (!avro)
      payload = parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(decoded));
  } catch (error) {
    throw error.message.endsWith('_unavailable')
      ? unavailable(error.message)
      : invalid('asyncapi_amqp_payload_invalid');
  }
  return {
    ...input,
    payload,
    payloadBytesBase64: decoded.toString('base64'),
    transport: {
      ...input.transport,
      contentType: properties.contentType,
      protocolVersion: '0.9.1',
      headers: logicalHeaders(properties.headers ?? {}, wire.binaryEncoding),
      amqp: {
        ...wire,
        publish,
        properties,
        body,
        decoded,
        packetHash: hash(Buffer.concat(wire.frames.map((frame) => Buffer.from(frame, 'base64')))),
        ...(transactionHash ? { transactionHash } : {}),
      },
    },
  };
}
export function validateAmqpBindings(model, message, servers, transport) {
  const channel = model.channelBindings.amqp ?? {},
    op = model.bindings.amqp ?? {},
    binding = message.bindings.amqp ?? {};
  const allowed = [
    [channel, ['is', 'exchange', 'queue', 'bindingVersion']],
    [
      op,
      [
        'expiration',
        'userId',
        'cc',
        'priority',
        'deliveryMode',
        'mandatory',
        'bcc',
        'timestamp',
        'bindingVersion',
      ],
    ],
    [binding, ['contentEncoding', 'messageType', 'bindingVersion']],
  ];
  if (servers.some((server) => Object.keys(server.bindings.amqp ?? {}).length))
    throw unavailable('asyncapi_amqp_server_binding_unavailable');
  for (const [value, names] of allowed) {
    if (Object.keys(value).some((name) => !names.includes(name)))
      throw unavailable('asyncapi_amqp_binding_unavailable');
    if (
      value.bindingVersion !== undefined &&
      !['0.1.0', '0.2.0', '0.3.0'].includes(value.bindingVersion)
    )
      throw unavailable('asyncapi_amqp_binding_version_unavailable');
  }
  const wire = transport.amqp,
    properties = wire.properties;
  const equal = (expected, actual, reason) => {
    if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(actual))
      throw invalid(reason);
  };
  if (channel.is !== undefined && !['queue', 'routingKey'].includes(channel.is))
    throw invalid('asyncapi_amqp_channel_binding_invalid');
  if (channel.is === 'queue') {
    if (
      channel.exchange !== undefined ||
      Object.keys(channel.queue ?? {}).some(
        (key) => !['name', 'vhost', 'durable', 'exclusive', 'autoDelete'].includes(key),
      )
    )
      throw unavailable('asyncapi_amqp_queue_topology_unavailable');
    equal('', wire.publish.fields.exchange, 'asyncapi_amqp_queue_exchange_mismatch');
    equal(channel.queue?.name, wire.publish.fields.routingKey, 'asyncapi_amqp_queue_mismatch');
    equal(channel.queue?.vhost ?? '/', wire.virtualHost, 'asyncapi_amqp_vhost_mismatch');
    validateDeclaration(channel.queue, 'queue', wire.publish.fields.routingKey);
  } else {
    if (
      channel.queue !== undefined ||
      Object.keys(channel.exchange ?? {}).some(
        (key) => !['name', 'vhost', 'type', 'durable', 'autoDelete'].includes(key),
      )
    )
      throw unavailable('asyncapi_amqp_exchange_topology_unavailable');
    equal(channel.exchange?.name, wire.publish.fields.exchange, 'asyncapi_amqp_exchange_mismatch');
    if (channel.exchange)
      equal(channel.exchange.vhost ?? '/', wire.virtualHost, 'asyncapi_amqp_vhost_mismatch');
    validateDeclaration(channel.exchange, 'exchange', wire.publish.fields.exchange);
  }
  function validateDeclaration(binding, kind, name) {
    if (!binding) return;
    // AMQP permits auto-delete to be ignored on existing declarations.
    if (binding.autoDelete !== undefined)
      throw unavailable('asyncapi_amqp_auto_delete_state_unavailable');
    const fields = kind === 'queue' ? ['durable', 'exclusive'] : ['type', 'durable'];
    if (!fields.some((field) => binding[field] !== undefined)) return;
    if (kind === 'exchange' && name === '') {
      if (binding.durable !== undefined)
        throw unavailable('asyncapi_amqp_default_exchange_state_unavailable');
      equal(binding.type, 'default', 'asyncapi_amqp_exchange_type_mismatch');
      return;
    }
    const declaration = amqpDeclaration(wire.declarations, kind, name, wire.publish.channel);
    for (const field of fields)
      equal(
        binding[field],
        declaration.fields[field],
        'asyncapi_amqp_' + kind + '_' + field + '_mismatch',
      );
    wire.topologyHash = declaration.hash;
  }
  for (const name of ['userId', 'priority', 'deliveryMode'])
    equal(op[name], properties[name], 'asyncapi_amqp_' + name + '_mismatch');
  if (op.expiration !== undefined)
    equal(String(op.expiration), properties.expiration, 'asyncapi_amqp_expiration_mismatch');
  equal(op.mandatory, wire.publish.fields.mandatory, 'asyncapi_amqp_mandatory_mismatch');
  equal(op.cc, properties.headers?.CC, 'asyncapi_amqp_cc_mismatch');
  equal(op.bcc, properties.headers?.BCC, 'asyncapi_amqp_bcc_mismatch');
  if (op.timestamp !== undefined)
    equal(op.timestamp, properties.timestamp !== undefined, 'asyncapi_amqp_timestamp_mismatch');
  equal(binding.contentEncoding, properties.contentEncoding, 'asyncapi_amqp_encoding_mismatch');
  equal(binding.messageType, properties.type, 'asyncapi_amqp_message_type_mismatch');
}
