import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
import { compiler } from './semantic-compare.mjs';
import { decodeMqttPacket } from './mqtt-wire.mjs';
import { avroBinaryContentType } from './asyncapi-avro.mjs';
import { protobufContentType } from './asyncapi-protobuf.mjs';
import { matchesMimeType, parseMimeType } from './mime-wire.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
export function mqttWireInput(input) {
  const version = input.transport?.mqtt?.version;
  if (
    ![4, 5].includes(version) ||
    typeof input.bytesBase64 !== 'string' ||
    input.bytesBase64.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64)
  )
    throw unavailable('asyncapi_mqtt_wire_unavailable');
  let packet;
  try {
    packet = decodeMqttPacket(Buffer.from(input.bytesBase64, 'base64'), version);
  } catch {
    throw invalid('asyncapi_mqtt_wire_invalid');
  }
  if (packet.cmd !== 'publish') throw invalid('asyncapi_mqtt_publish_required');
  if (!packet.topic || packet.wireProperties?.topicAlias !== undefined)
    throw unavailable('asyncapi_mqtt_topic_alias_unavailable');
  if (input.direction !== 'output' && packet.propertyIds?.includes(0x0b))
    throw invalid('asyncapi_mqtt_subscription_identifier_invalid');
  const properties = packet.wireProperties ?? {};
  if (
    properties.responseTopic !== undefined &&
    (!properties.responseTopic || /[#+]/.test(properties.responseTopic))
  )
    throw invalid('asyncapi_mqtt_response_topic_invalid');
  if (input.transport.channel !== packet.topic) throw invalid('asyncapi_mqtt_channel_mismatch');
  const acknowledgments = input.transport.mqtt.acknowledgments ?? [],
    retries = input.transport.mqtt.retries ?? [],
    recovery = input.transport.mqtt.recovery ?? [];
  if (
    !Array.isArray(acknowledgments) ||
    acknowledgments.length > 16 ||
    !Array.isArray(retries) ||
    retries.length > 16 ||
    !Array.isArray(recovery) ||
    recovery.length > 8
  )
    throw unavailable('asyncapi_mqtt_delivery_evidence_unavailable');
  if (packet.dup) throw unavailable('asyncapi_mqtt_initial_retry_unavailable');
  let priorConnection = input.transport.mqtt.connectionId;
  const connections = new Set([priorConnection]);
  for (const event of recovery) {
    if (
      !event ||
      event.from !== priorConnection ||
      typeof event.to !== 'string' ||
      connections.has(event.to) ||
      typeof event.connackBase64 !== 'string' ||
      event.connackBase64.length > 65536 ||
      input.transport.mqtt.connect?.clean !== false
    )
      throw unavailable('asyncapi_mqtt_recovery_unavailable');
    const raw = Buffer.from(event.connackBase64, 'base64');
    if (hash(raw) !== event.connackHash) throw unavailable('asyncapi_mqtt_recovery_unavailable');
    const connack = decodeMqttPacket(raw, version);
    if (
      connack.cmd !== 'connack' ||
      !connack.sessionPresent ||
      Number(connack.reasonCode ?? connack.returnCode ?? 0) !== 0
    )
      throw invalid('asyncapi_mqtt_session_recovery_invalid');
    connections.add(event.to);
    priorConnection = event.to;
  }
  const original = Buffer.from(input.bytesBase64, 'base64');
  for (const encoded of retries) {
    if (typeof encoded !== 'string' || encoded.length > 1398104)
      throw unavailable('asyncapi_mqtt_retry_unavailable');
    const bytes = Buffer.from(encoded, 'base64'),
      repeated = decodeMqttPacket(bytes, version);
    if (!repeated.dup || repeated.cmd !== 'publish') throw invalid('asyncapi_mqtt_retry_invalid');
    bytes[0] &= ~8;
    if (!bytes.equals(original)) throw invalid('asyncapi_mqtt_retry_invalid');
  }
  let phase = 0;
  const incoming = input.direction === 'output',
    brokerDirection = incoming ? 'out' : 'in',
    clientDirection = incoming ? 'in' : 'out';
  for (const event of acknowledgments) {
    if (
      !event ||
      !['in', 'out'].includes(event.direction) ||
      typeof event.frameBase64 !== 'string' ||
      event.frameBase64.length > 65536
    )
      throw unavailable('asyncapi_mqtt_acknowledgment_unavailable');
    const raw = Buffer.from(event.frameBase64, 'base64');
    if (hash(raw) !== event.frameHash)
      throw unavailable('asyncapi_mqtt_acknowledgment_unavailable');
    const ack = decodeMqttPacket(raw, version);
    if (ack.messageId !== packet.messageId || Number(ack.reasonCode ?? 0) >= 128)
      throw invalid('asyncapi_mqtt_delivery_rejected');
    if (
      !(['puback', 'pubrec'].includes(ack.cmd) ? [0, 16] : [0]).includes(
        Number(ack.reasonCode ?? 0),
      )
    )
      throw invalid('asyncapi_mqtt_acknowledgment_reason_invalid');
    if (
      packet.qos === 1 &&
      phase === 0 &&
      event.direction === brokerDirection &&
      ack.cmd === 'puback'
    )
      phase = 3;
    else if (
      packet.qos === 2 &&
      [0, 1, 2].includes(phase) &&
      event.direction === brokerDirection &&
      ack.cmd === 'pubrec'
    )
      phase = 1;
    else if (
      packet.qos === 2 &&
      [1, 2].includes(phase) &&
      event.direction === clientDirection &&
      ack.cmd === 'pubrel'
    )
      phase = 2;
    else if (
      packet.qos === 2 &&
      phase === 2 &&
      event.direction === brokerDirection &&
      ack.cmd === 'pubcomp'
    )
      phase = 3;
    else throw invalid('asyncapi_mqtt_acknowledgment_order_invalid');
  }
  if (packet.qos > 0 && phase !== 3) throw unavailable('asyncapi_mqtt_delivery_incomplete');
  const contentType = properties.contentType ?? input.transport.contentType;
  const avro = avroBinaryContentType(contentType) || protobufContentType(contentType);
  if (!avro && !/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(contentType ?? ''))
    throw unavailable('asyncapi_mqtt_payload_codec_unavailable');
  let payload;
  try {
    if (!avro)
      payload = parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(packet.payload));
  } catch {
    throw invalid('asyncapi_mqtt_payload_invalid');
  }
  return {
    ...input,
    payload,
    payloadBytesBase64: packet.payload.toString('base64'),
    transport: {
      ...input.transport,
      protocolVersion: version === 5 ? '5.0' : '3.1.1',
      contentType,
      headers: packet.userProperties ?? {},
      mqtt: { ...input.transport.mqtt, packet, properties },
    },
  };
}
export function validateMqttBindings(model, message, servers, transport) {
  const op = model.bindings.mqtt ?? {},
    binding = message.bindings.mqtt ?? {};
  const selected = [...servers.map((server) => server.bindings.mqtt ?? {}), op, binding];
  if (
    selected.some(
      (value) =>
        value.bindingVersion !== undefined && !['0.1.0', '0.2.0'].includes(value.bindingVersion),
    )
  )
    throw unavailable('asyncapi_mqtt_binding_version_unavailable');
  if (Object.keys(model.channelBindings.mqtt ?? {}).length)
    throw unavailable('asyncapi_mqtt_channel_binding_unavailable');
  const expected = [
    [op, ['qos', 'retain', 'messageExpiryInterval', 'bindingVersion']],
    [
      binding,
      [
        'payloadFormatIndicator',
        'correlationData',
        'contentType',
        'responseTopic',
        'bindingVersion',
      ],
    ],
    ...servers.map((server) => [
      server.bindings.mqtt ?? {},
      [
        'clientId',
        'cleanSession',
        'lastWill',
        'keepAlive',
        'sessionExpiryInterval',
        'maximumPacketSize',
        'bindingVersion',
      ],
    ]),
  ];
  if (expected.some(([value, names]) => Object.keys(value).some((name) => !names.includes(name))))
    throw unavailable('asyncapi_mqtt_binding_unavailable');
  if (!selected.some((value) => Object.keys(value).some((name) => name !== 'bindingVersion')))
    return;
  const wire = transport.mqtt;
  if (!wire?.packet) throw unavailable('asyncapi_mqtt_wire_unavailable');
  const equal = (expected, actual, reason) => {
    if (expected !== undefined && expected !== actual) throw invalid(reason);
  };
  equal(op.qos, wire.packet.qos, 'asyncapi_mqtt_qos_mismatch');
  equal(op.retain, wire.packet.retain, 'asyncapi_mqtt_retain_mismatch');
  const value = (declared, actual, context, reason) => {
    if (declared === undefined) return;
    if (actual === undefined) throw invalid(reason);
    if (typeof declared !== 'object' || declared === null) return equal(declared, actual, reason);
    if (!context?.available) throw unavailable('asyncapi_mqtt_binding_schema_unavailable');
    if (!compiler(context.schema, context.resources, context.dialect)(actual))
      throw invalid(reason);
  };
  value(
    op.messageExpiryInterval,
    wire.properties.messageExpiryInterval,
    model.mqttExpiry,
    'asyncapi_mqtt_expiry_mismatch',
  );
  equal(
    binding.payloadFormatIndicator,
    wire.properties.payloadFormatIndicator ?? 0,
    'asyncapi_mqtt_payload_format_mismatch',
  );
  if (binding.contentType !== undefined &&
    (typeof wire.properties.contentType !== 'string' || !matchesMimeType(binding.contentType, parseMimeType(wire.properties.contentType))))
    throw invalid('asyncapi_mqtt_content_type_mismatch');
  value(
    binding.responseTopic,
    wire.properties.responseTopic,
    message.mqttResponseTopic,
    'asyncapi_mqtt_response_topic_mismatch',
  );
  if (binding.correlationData !== undefined) {
    if (!['utf8', 'base64'].includes(wire.binaryEncoding) || !wire.properties.correlationData)
      throw unavailable('asyncapi_mqtt_binary_representation_unavailable');
    let correlation;
    try {
      correlation =
        wire.binaryEncoding === 'base64'
          ? wire.properties.correlationData.toString('base64')
          : new TextDecoder('utf8', { fatal: true }).decode(wire.properties.correlationData);
    } catch {
      throw invalid('asyncapi_mqtt_correlation_encoding_invalid');
    }
    value(
      binding.correlationData,
      correlation,
      message.mqttCorrelation,
      'asyncapi_mqtt_correlation_mismatch',
    );
  }
  for (const server of servers) {
    const declared = server.bindings.mqtt ?? {};
    if (!Object.keys(declared).some((key) => key !== 'bindingVersion')) continue;
    const connect = wire.connect;
    if (!connect) throw unavailable('asyncapi_mqtt_connect_unavailable');
    equal(
      declared.clientId === undefined ? undefined : hash(declared.clientId),
      connect.clientIdHash,
      'asyncapi_mqtt_client_id_mismatch',
    );
    equal(declared.cleanSession, connect.clean, 'asyncapi_mqtt_session_mismatch');
    equal(declared.keepAlive, connect.keepalive, 'asyncapi_mqtt_keepalive_mismatch');
    value(
      declared.sessionExpiryInterval,
      connect.properties?.sessionExpiryInterval ?? 0,
      server.mqttSessionExpiry,
      'asyncapi_mqtt_session_expiry_mismatch',
    );
    value(
      declared.maximumPacketSize,
      connect.properties?.maximumPacketSize ?? 268435455,
      server.mqttMaximumPacketSize,
      'asyncapi_mqtt_maximum_packet_mismatch',
    );
    if (declared.lastWill) {
      if (
        !connect.will ||
        Object.keys(declared.lastWill).some(
          (name) => !['topic', 'qos', 'message', 'retain'].includes(name),
        )
      )
        throw unavailable('asyncapi_mqtt_will_unavailable');
      for (const key of ['topic', 'qos', 'retain'])
        equal(declared.lastWill[key], connect.will[key], 'asyncapi_mqtt_will_mismatch');
      equal(
        declared.lastWill.message === undefined ? undefined : hash(declared.lastWill.message),
        connect.will.payloadHash,
        'asyncapi_mqtt_will_mismatch',
      );
    }
  }
}
