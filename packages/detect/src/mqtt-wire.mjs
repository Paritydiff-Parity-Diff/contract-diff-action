import mqtt from 'mqtt-packet';
const LIMIT = 1024 * 1024;
const invalid = () => new Error('mqtt_wire_invalid');
export function mqttFrameLength(input) {
  if (input.length < 2) return undefined;
  let length = 0,
    scale = 1;
  for (let index = 1; index <= 4; index++) {
    if (index >= input.length) return undefined;
    const byte = input[index];
    length += (byte & 127) * scale;
    if (!(byte & 128)) {
      if (index > 1 && byte === 0) throw invalid();
      if (length + index + 1 > LIMIT) throw new Error('mqtt_wire_size_limit');
      return { length: length + index + 1, offset: index + 1 };
    }
    scale *= 128;
  }
  throw invalid();
}
const text = (bytes) => {
  const value = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  if (value.includes('\0')) throw invalid();
  return value;
};
export function decodeMqttPacket(input, version = 5) {
  if (![4, 5].includes(version) || !(input instanceof Uint8Array)) throw invalid();
  const bytes = Buffer.from(input),
    frame = mqttFrameLength(bytes);
  if (!frame || frame.length !== bytes.length) throw invalid();
  const packets = [],
    parser = mqtt.parser({ protocolVersion: version });
  let error;
  parser.on('error', (value) => {
    error = value;
  });
  parser.on('packet', (packet) => packets.push(packet));
  if (parser.parse(bytes) || error || packets.length !== 1) throw invalid();
  const packet = packets[0];
  if (
    ['publish', 'puback', 'pubrec', 'pubrel', 'pubcomp'].includes(packet.cmd) &&
    packet.qos &&
    !packet.messageId
  )
    throw invalid();
  if (['puback', 'pubrec', 'pubrel', 'pubcomp'].includes(packet.cmd) && !packet.messageId)
    throw invalid();
  if (packet.cmd !== 'publish') return packet;
  if (packet.qos === 0 && packet.dup) throw invalid();
  let cursor = frame.offset;
  const requireBytes = (length) => {
    if (length > bytes.length - cursor) throw invalid();
  };
  const uint = (length) => {
    requireBytes(length);
    const value = bytes.readUIntBE(cursor, length);
    cursor += length;
    return value;
  };
  const binary = () => {
    const length = uint(2);
    requireBytes(length);
    const value = bytes.subarray(cursor, cursor + length);
    cursor += length;
    return value;
  };
  const variable = () => {
    let value = 0,
      scale = 1;
    for (let index = 0; index < 4; index++) {
      const byte = uint(1);
      value += (byte & 127) * scale;
      if (!(byte & 128)) {
        if (index && byte === 0) throw invalid();
        return value;
      }
      scale *= 128;
    }
    throw invalid();
  };
  const topic = text(binary());
  if (/[#+]/.test(topic)) throw invalid();
  if (packet.qos && !uint(2)) throw invalid();
  const properties = new Map(),
    userProperties = [];
  if (version === 5) {
    const size = variable(),
      end = cursor + size;
    requireBytes(size);
    while (cursor < end) {
      const id = variable();
      if (properties.has(id) && ![0x0b, 0x26].includes(id)) throw invalid();
      let value;
      if ([0x01].includes(id)) {
        value = uint(1);
        if (value > 1) throw invalid();
      } else if (id === 0x02) value = uint(4);
      else if ([0x03, 0x08].includes(id)) value = text(binary());
      else if (id === 0x09) value = binary();
      else if (id === 0x0b) {
        value = variable();
        if (!value) throw invalid();
      } else if (id === 0x23) {
        value = uint(2);
        if (!value) throw invalid();
      } else if (id === 0x26) {
        value = [text(binary()), text(binary())];
        userProperties.push(value);
      } else throw invalid();
      properties.set(id, value);
      if (cursor > end) throw invalid();
    }
    if (cursor !== end) throw invalid();
  }
  if (!topic && !properties.has(0x23)) throw invalid();
  if (userProperties.length > 128) throw new Error('mqtt_wire_header_limit');
  const headers = new Map();
  for (const [name, value] of userProperties)
    headers.set(name, headers.has(name) ? [].concat(headers.get(name), value) : value);
  return {
    ...packet,
    topic,
    payload: bytes.subarray(cursor),
    userProperties: Object.fromEntries(headers),
    propertyIds: [...properties.keys()],
    wireProperties: {
      payloadFormatIndicator: properties.get(0x01),
      messageExpiryInterval: properties.get(0x02),
      contentType: properties.get(0x03),
      responseTopic: properties.get(0x08),
      correlationData: properties.get(0x09),
      topicAlias: properties.get(0x23),
    },
  };
}
export function mqttPacketStream(version, onPacket) {
  let pending = Buffer.alloc(0),
    frames = 0;
  return {
    push(input) {
      if (!(input instanceof Uint8Array) || input.length > LIMIT) throw invalid();
      pending = Buffer.concat([pending, input]);
      while (pending.length) {
        const frame = mqttFrameLength(pending);
        if (!frame || frame.length > pending.length) {
          if (pending.length > LIMIT) throw new Error('mqtt_wire_size_limit');
          break;
        }
        if (++frames > 4096) throw new Error('mqtt_wire_frame_limit');
        const bytes = pending.subarray(0, frame.length);
        pending = pending.subarray(frame.length);
        onPacket(decodeMqttPacket(bytes, version), bytes);
      }
    },
    finish() {
      if (pending.length) throw invalid();
    },
  };
}
