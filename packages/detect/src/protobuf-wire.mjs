export function validateProtobufWire(bytes, type, root) {
  let nodes = 0;
  let unknownFields = 0,
    mismatchedFields = 0;
  const step = (depth) => {
    if (depth > 32 || ++nodes > 100000) throw new Error('grpc_wire_resource_limit');
  };
  const cursor = (bytes) => ({ bytes, pos: 0 });
  const uint = (reader) => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (reader.pos === reader.bytes.length) throw new Error('grpc_wire_invalid');
      const byte = reader.bytes[reader.pos++];
      if (index === 9 && byte > 1) throw new Error('grpc_wire_invalid');
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (byte < 128) return value;
    }
    throw new Error('grpc_wire_invalid');
  };
  const take = (reader, length) => {
    if (length > reader.bytes.length - reader.pos) throw new Error('grpc_wire_invalid');
    const value = reader.bytes.subarray(reader.pos, reader.pos + length);
    reader.pos += length;
    return value;
  };
  const lengthBytes = (reader) => {
    const length = uint(reader);
    if (length > 0xffffffffn) throw new Error('grpc_wire_invalid');
    return take(reader, Number(length));
  };
  const tag = (reader) => {
    const value = uint(reader);
    if (value > 0xffffffffn || value < 8n || (value & 7n) > 5n)
      throw new Error('grpc_wire_invalid');
    return { id: Number(value >> 3n), wire: Number(value & 7n) };
  };
  const skip = (reader, wire, id, depth) => {
    if (wire === 0) uint(reader);
    else if (wire === 1) take(reader, 8);
    else if (wire === 2) lengthBytes(reader);
    else if (wire === 5) take(reader, 4);
    else if (wire === 3) {
      while (reader.pos < reader.bytes.length) {
        step(depth + 1);
        const next = tag(reader);
        if (next.wire === 4) {
          if (next.id !== id) throw new Error('grpc_wire_invalid');
          return;
        }
        skip(reader, next.wire, next.id, depth + 1);
      }
      throw new Error('grpc_wire_invalid');
    } else throw new Error('grpc_wire_invalid');
  };
  const nested = (field) => field.resolvedType?.fieldsById !== undefined;
  const expected = (field) =>
    field.map || ['string', 'bytes'].includes(field.type)
      ? 2
      : nested(field)
        ? field.resolvedType.group
          ? 3
          : 2
        : ['double', 'fixed64', 'sfixed64'].includes(field.type)
          ? 1
          : ['float', 'fixed32', 'sfixed32'].includes(field.type)
            ? 5
            : 0;
  const scalar = (reader, field, wire) => {
    if (wire === 2) {
      const bytes = lengthBytes(reader);
      return field.type === 'string'
        ? new TextDecoder('utf8', { fatal: true }).decode(bytes)
        : bytes;
    }
    if (wire === 1 || wire === 5) {
      const bytes = take(reader, wire === 1 ? 8 : 4);
      if (field.type === 'float' || field.type === 'double') return true;
      let value = 0n;
      for (let index = bytes.length - 1; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[index]);
      return field.type.startsWith('s') ? BigInt.asIntN(bytes.length * 8, value) : value;
    }
    const value = uint(reader);
    if (field.type === 'bool') return value !== 0n;
    if (field.type.startsWith('sint')) {
      const narrowed = BigInt.asUintN(field.type === 'sint32' ? 32 : 64, value);
      return (narrowed >> 1n) ^ -(narrowed & 1n);
    }
    return field.type.startsWith('u')
      ? BigInt.asUintN(field.type === 'uint32' ? 32 : 64, value)
      : BigInt.asIntN(field.type === 'int64' ? 64 : 32, value);
  };
  const parse = (reader, message, depth, state = new Map(), groupId) => {
    step(depth);
    while (reader.pos < reader.bytes.length) {
      step(depth);
      const { id, wire } = tag(reader);
      if (wire === 4) {
        if (groupId !== id) throw new Error('grpc_wire_invalid');
        return state;
      }
      const field = message.fieldsById[id];
      if (!field) {
        unknownFields++;
        skip(reader, wire, id, depth);
        continue;
      }
      const kind = expected(field);
      if (wire !== kind && !(wire === 2 && field.repeated && [0, 1, 5].includes(kind))) {
        unknownFields++;
        mismatchedFields++;
        skip(reader, wire, id, depth);
        continue;
      }
      if (field.partOf)
        for (const sibling of field.partOf.fieldsArray)
          if (sibling.id !== id) state.delete(sibling.id);
      if (field.map) {
        const entryType = {
          fieldsById: {
            1: { id: 1, type: field.keyType },
            2: { id: 2, type: field.type, resolvedType: field.resolvedType },
          },
        };
        const entry = parse(cursor(lengthBytes(reader)), entryType, depth + 1);
        const key =
          entry.get(1)?.value ??
          (field.keyType === 'string' ? '' : field.keyType === 'bool' ? false : 0n);
        const values = state.get(id)?.value ?? new Map();
        values.set(String(key), entry.get(2)?.value ?? (nested(field) ? new Map() : undefined));
        state.set(id, { field, value: values });
      } else if (nested(field)) {
        const previous = field.repeated ? undefined : state.get(id)?.value;
        const value = parse(
          wire === 3 ? reader : cursor(lengthBytes(reader)),
          field.resolvedType,
          depth + 1,
          previous,
          wire === 3 ? id : undefined,
        );
        if (field.repeated) {
          const values = state.get(id)?.value ?? [];
          values.push(value);
          state.set(id, { field, value: values });
        } else state.set(id, { field, value });
      } else if (wire === 2 && kind !== 2) {
        const packed = cursor(lengthBytes(reader));
        while (packed.pos < packed.bytes.length) {
          step(depth);
          scalar(packed, field, kind);
        }
        state.set(id, { field, value: true });
      } else state.set(id, { field, value: scalar(reader, field, wire) });
    }
    if (groupId !== undefined) throw new Error('grpc_wire_invalid');
    return state;
  };
  const visit = (state, message, depth) => {
    step(depth);
    for (const field of message.fieldsArray)
      if (field.required && !state.has(field.id))
        throw new Error('grpc_descriptor_message_invalid');
    for (const { field, value } of state.values()) {
      if (!nested(field)) continue;
      const values = field.map ? value.values() : field.repeated ? value : [value];
      for (const entry of values) visit(entry, field.resolvedType, depth + 1);
    }
    if (message.fullName !== '.google.protobuf.Any') return;
    const urlField = message.fieldsById[1],
      valueField = message.fieldsById[2];
    if (
      message.fieldsArray.length !== 2 ||
      urlField?.type !== 'string' ||
      valueField?.type !== 'bytes' ||
      [urlField, valueField].some(
        (field) => field.repeated || field.map || field.required || field.partOf,
      )
    )
      throw new Error('grpc_any_type_unavailable');
    const url = state.get(1)?.value ?? '',
      embedded = state.get(2)?.value ?? Buffer.alloc(0);
    if (!url && !embedded.length) return;
    if (!/\/(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*$/.test(url))
      throw new Error('grpc_wire_invalid');
    let embeddedType;
    try {
      embeddedType = root.lookupType(url.slice(url.lastIndexOf('/') + 1));
    } catch {
      throw new Error('grpc_any_type_unavailable');
    }
    visit(parse(cursor(embedded), embeddedType, depth + 1), embeddedType, depth + 1);
  };
  const state = parse(cursor(bytes), type, 0);
  visit(state, type, 0);
  return { fields: state, unknownFields, mismatchedFields };
}
